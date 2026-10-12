import type { SessionContextBreakdown } from 'claude-code'
import { type Engine, describe, expect, test } from 'claude-code/testing'

import type { Facts } from '../types'

import { computeAdvice } from '../hooks/lib/advice'
import { applyCleared, initialFacts } from '../hooks/lib/facts'
import { heavyFrom } from '../hooks/lib/heavy'
import { initialModes } from '../hooks/lib/modes'
import { WINDOW_COMMAND, computeOffers } from '../hooks/lib/offers'
import { statusRows } from '../hooks/lib/status'

import { answer, bandProps, engine, measure, offerPaneProps, paneProps } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const DIALOG = 'tokenomics-offer'

const FREE = { name: 'Free space', tokens: 500_000, color: 'x', kind: 'free' }

/** What the breakdown says of a session that has grown, with the engine's own auto-compact size. */
const late = { autoCompactWindow: { threshold: 967_000, source: 'auto' } }

const agentTurn = ($: Engine, spent: number, agentId = 'sub-1') =>
  $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: `t-${agentId}`,
    reason: 'answer',
    agentId,
    usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: spent - 5, cache_read_input_tokens: 0, model: 'm' },
  } as never)

const resumed = (over: Record<string, unknown> = {}) =>
  ({
    session_id: 's1',
    transcript_path: '/tmp/s1.jsonl',
    cwd: '/tmp',
    hook_event_name: 'SessionStart',
    source: 'resume',
    seconds_since_last_response: 4_000,
    context_tokens: 80_000,
    prompt_cache_likely_expired: true,
    estimated_cache_write_usd: 0.4,
    ...over,
  }) as never

describe('the auto-compact window', () => {
  const facts = (over: Partial<Facts> = {}): Facts => ({
    ...initialFacts,
    contextTokens: 150_000,
    contextWindow: 1_000_000,
    contextPercent: 15,
    autoCompactThreshold: 967_000,
    autoCompactSource: 'auto',
    hasGrown: true,
    ...over,
  })
  const kinds = (f: Facts) => computeOffers({ facts: f, modes: initialModes, modelRow: null }).map(o => o.kind)

  test('a long conversation that the engine will let grow to 967k is offered a window of 200k', () => {
    expect(kinds(facts())).toContain('window')
    const offer = computeOffers({ facts: facts(), modes: initialModes, modelRow: null }).find(o => o.kind === 'window')
    expect(offer?.does).toContain(WINDOW_COMMAND)
    expect(offer?.does).toContain('/autocompact auto')
    expect(offer?.why).toContain('967k')
  })

  test('nothing is offered while the conversation is small, where the size is already short, or where someone chose it', () => {
    expect(kinds(facts({ hasGrown: false, contextTokens: 100_000 }))).not.toContain('window')
    expect(kinds(facts({ autoCompactThreshold: 160_000 }))).not.toContain('window')
    // Auto-compaction off: no size at all.
    expect(kinds(facts({ autoCompactThreshold: null }))).not.toContain('window')
    expect(kinds(facts({ autoCompactSource: 'settings' }))).not.toContain('window')
    expect(kinds(facts({ autoCompactSource: 'env' }))).not.toContain('window')
    expect(kinds(facts({ autoCompactSource: 'model-default' }))).toContain('window')
  })

  test('having been heavy is enough: it is still offered once a compaction has lightened the conversation', () => {
    expect(kinds(facts({ contextTokens: 40_000, contextPercent: 4 }))).toContain('window')
    // A conversation that never got there is not offered it.
    expect(kinds(facts({ hasGrown: false, contextTokens: 40_000, contextPercent: 4 }))).not.toContain('window')
  })

  test('a person who accepts the compaction is offered the window next, as one who puts it off is', async ($, on) => {
    const calls = engine(on, { ...late, compacted: { tokensBefore: 150_000, tokensAfter: 40_000 } })
    await $.session.start(START)
    await $.session.measure(measure.context(15, 1_000_000))
    await answer($, 'accept')
    expect(calls.compacts).toBe(1)

    // The conversation is light now: the next moment still brings the window.
    await $.session.measure(measure.context(4, 1_000_000))
    expect(calls.opened).toEqual([DIALOG, DIALOG])
    const second = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
    expect(await second.find({ type: 'Text', text: '自動要約が、かなり先になっています' })).toBeDefined()
  })

  test('it says the window, not the size compaction will start at, which is a little before it', () => {
    const offer = computeOffers({ facts: facts(), modes: initialModes, modelRow: null }).find(o => o.kind === 'window')
    expect(offer?.does).toContain('自動要約の窓が約200k tok')
    expect(offer?.does).toContain('少し手前')
  })

  test('/clear is a new conversation: having grown starts over, so nothing about the window is offered for it', async ($, on) => {
    const calls = engine(on, late)
    await $.session.start(START)
    await $.session.measure(measure.context(15, 1_000_000))
    await answer($, 'later')
    expect(calls.opened.length).toBe(1)

    await $.session.end({ reason: 'clear' } as never)
    await $.session.measure(measure.context(4, 1_000_000))
    expect(calls.opened.length).toBe(1)
    expect(applyCleared({ ...initialFacts, hasGrown: true }).hasGrown).toBe(false)
  })

  test('it comes after the compaction the same conversation calls for, and accepting only types the command', async ($, on) => {
    const calls = engine(on, late)
    await $.session.start(START)

    await $.session.measure(measure.context(15, 1_000_000))
    expect(calls.opened).toEqual([DIALOG])
    const first = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
    expect(await first.find({ type: 'Text', text: '会話が重くなってきました' })).toBeDefined()
    await first.unmount()
    await answer($, 'later')

    // The next moment: the window.
    await $.session.measure(measure.context(16, 1_000_000))
    expect(calls.opened).toEqual([DIALOG, DIALOG])
    const second = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
    expect(await second.find({ type: 'Text', text: '自動要約が、かなり先になっています' })).toBeDefined()
    await second.unmount()

    await answer($, 'accept')
    expect(calls.filled).toEqual([WINDOW_COMMAND])
    expect(calls.configSets).toEqual([])
    expect(calls.toasts.at(-1)).toContain('Enter で /autocompact 200k を実行します')

    // Once a session, as every kind is.
    await $.session.measure(measure.context(17, 1_000_000))
    expect(calls.opened.length).toBe(2)
  })

  test('what the person had typed is never overwritten: they are told what to type', async ($, on) => {
    const calls = engine(on, { ...late, draft: 'half a sentence' })
    await $.session.start(START)
    await $.session.measure(measure.context(15, 1_000_000))
    await answer($, 'later')
    await $.session.measure(measure.context(16, 1_000_000))
    await answer($, 'accept')

    expect(calls.filled).toEqual([])
    expect(calls.toasts.at(-1)).toContain('/autocompact 200k と入力して Enter')
  })

  test('"もう出さない" silences it, as for any other kind', async ($, on) => {
    const calls = engine(on, late)
    await $.session.start(START)
    await $.session.measure(measure.context(15, 1_000_000))
    await answer($, 'later')
    await $.session.measure(measure.context(16, 1_000_000))
    await answer($, 'mute')

    expect(calls.store.get('mutedOffers')).toEqual(['window'])
  })

  test('with the default size of 160k nothing about the window ever arises', async ($, on) => {
    const calls = engine(on)
    await $.session.start(START)
    await $.session.measure(measure.context(15, 1_000_000))
    await answer($, 'later')
    await $.session.measure(measure.context(16, 1_000_000))
    expect(calls.opened.length).toBe(1)
  })
})

describe('what subagents spend', () => {
  test('is counted apart from the main loop’s own turn, and shown beside it once it is worth a word', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    const finish = (usage: Record<string, unknown>) =>
      $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)

    await agentTurn($, 19_995)
    // The agent's tokens are not the main loop's: "this turn" has nothing yet.
    expect(await band.find({ type: 'Text', text: '—' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '20k tok' })).toBeDefined()

    await finish({ input_tokens: 4, output_tokens: 150, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 5_000, model: 'm' })
    // 4 uncached + 1,000 written + 5,000 read; 150 out. The agents' 20k is not in it.
    expect(await band.find({ type: 'Text', text: '入力 6k tok' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '150 tok' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '20k tok' })).toBeDefined()

    // A new prompt starts a new turn: its agents' tokens are counted from nothing.
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as never)
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeUndefined()
  })

  test('an agent reporting back (a peer message, as the engine sends it), or any other thing sent in, is the same piece of work: the figure stays; a prompt of the person’s clears it', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await agentTurn($, 33_000)
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeDefined()

    for (const kind of ['peer', 'peer-send-message', 'task-notification', 'scheduled-trigger', 'channel', 'projects-relay']) {
      await $.prompt.submit({ text: '<agent-message from="a1">[Subagent hand-back] done', wait: false, origin: { kind } } as never)
      expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeDefined()
    }

    // The person at the keyboard, from a remote client, or driving it from a program: all move on.
    for (const kind of ['composer', 'bridge', 'sdk']) {
      await agentTurn($, 33_000)
      expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeDefined()
      await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind } } as never)
      expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeUndefined()
    }
  })

  test('a small helper is not worth a word in the band, but is in the pane, and the total keeps counting', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await agentTurn($, 600)
    await agentTurn($, 700, 'sub-2')
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '1.3k tok' })).toBeDefined()

    const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /1\.3k tok（2 回/ })).toBeDefined()
  })

  test('the status rows name them only when there were some, and /clear starts the count over', async ($, on) => {
    engine(on)
    expect(statusRows(initialFacts).map(r => r.label)).not.toContain('エージェント')
    expect(statusRows({ ...initialFacts, agentTokens: 42_000, agentRuns: 3 }).find(r => r.label === 'エージェント')?.value).toBe(
      '42k tok（3 回。上の数字には含みません）',
    )

    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await agentTurn($, 20_000)
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeDefined()
    await $.session.end({ reason: 'clear' } as never)
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeUndefined()
  })

  test('a turn of an agent that reports no usage counts for nothing', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer', agentId: 'sub-1' } as never)
    expect(await band.find({ type: 'Text', text: 'エージェント' })).toBeUndefined()
  })
})

describe('a session resumed after a pause', () => {
  test('is told what the first reply will read again, in dollars on an API key', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.classic.SessionStart(resumed())

    expect(await band.find({ type: 'Text', text: /前回から約67分あきました。最初の返信で会話全体（約80k tok）を読み直します/ })).toBeDefined()
    expect(await band.find({ key: 'later' })).toBeDefined()
    expect(computeAdvice({ ...initialFacts, resumeCold: { tokens: 80_000, usd: 0.4, idleMinutes: 67 } })[0]?.detail).toContain('約$0.40')
  })

  test('and in limit, never in dollars, on a subscription', () => {
    const advice = computeAdvice({
      ...initialFacts,
      resumeCold: { tokens: 80_000, usd: 0.4, idleMinutes: 67 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 30 }],
    })
    const detail = advice.find(a => a.id === 'resume-cold')?.detail ?? ''
    expect(detail).toContain('上限を多く使います')
    expect(detail).not.toContain('$')
    // And it says plainly that only a fresh start avoids the re-read.
    expect(detail).toContain('/clear')
    expect(detail).toContain('最初の1回は同じ')
  })

  test('long gaps are said in hours', () => {
    const title = computeAdvice({ ...initialFacts, resumeCold: { tokens: 50_000, usd: 0.2, idleMinutes: 600 } })[0]?.title
    expect(title).toContain('約10時間')
  })

  test('is told nothing when the cache is still warm, the conversation is small, or it is not a resume', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    for (const over of [
      { prompt_cache_likely_expired: false },
      { context_tokens: 5_000 },
      { source: 'startup' },
      { source: 'clear' },
    ]) {
      await $.classic.SessionStart(resumed(over))
      expect(await band.find({ type: 'Text', text: /前回から/ })).toBeUndefined()
    }
    // A fork is a resume, as far as the cache goes.
    await $.classic.SessionStart(resumed({ source: 'fork' }))
    expect(await band.find({ type: 'Text', text: /前回から/ })).toBeDefined()
  })

  test('the word goes once the first prompt is sent: it is under way', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.classic.SessionStart(resumed())
    expect(await band.find({ type: 'Text', text: /前回から/ })).toBeDefined()

    await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } } as never)
    expect(await band.find({ type: 'Text', text: /前回から/ })).toBeUndefined()
  })

  test('a slash command is not that prompt: the word stays', async ($, on) => {
    engine(on)
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.classic.SessionStart(resumed())
    await $.prompt.submit({ text: '/tokenomics', wait: false, origin: { kind: 'composer' } } as never)
    expect(await band.find({ type: 'Text', text: /前回から/ })).toBeDefined()
  })
})

describe('what is always in the window', () => {
  const breakdown = (extra: Record<string, unknown>, categories: { name: string; tokens: number; kind: string }[]): SessionContextBreakdown =>
    ({ categories: [...categories, FREE], memoryFiles: [], mcpTools: [], agents: [], ...extra }) as unknown as SessionContextBreakdown

  test('memory files are listed biggest first, with the rule of thumb once they are large', () => {
    const items = heavyFrom(
      breakdown(
        {
          memoryFiles: [
            { path: '/Users/x/.claude/CLAUDE.md', type: 'User', tokens: 900 },
            { path: '/work/app/CLAUDE.md', type: 'Project', tokens: 4_200 },
            { path: '/work/app/.claude/rules/a.md', type: 'Project', tokens: 300 },
            { path: '/work/app/.claude/rules/b.md', type: 'Project', tokens: 100 },
          ],
        },
        [{ name: 'Memory files', tokens: 5_500, kind: 'used' }],
      ),
    )
    const memory = items.find(i => i.name === 'CLAUDE.md などのメモリ')
    expect(memory?.details).toEqual(['Project: app/CLAUDE.md  4.2k tok', 'User: .claude/CLAUDE.md  900 tok', 'Project: rules/a.md  300 tok'])
    expect(memory?.hint).toContain('200 行以内')
  })

  test('skills say how many there are, which are biggest, and which the listing could not hold', () => {
    const skills = (included: number) => ({
      totalSkills: 92,
      includedSkills: included,
      tokens: 7_554,
      skillFrontmatter: [
        { name: 'docs', source: 'syncedSkills', tokens: 343 },
        { name: 'dataviz', source: 'built-in', tokens: 482 },
        { name: 'review', source: 'plugin', pluginName: 'gstack', tokens: 300 },
        { name: 'tiny', source: 'plugin', tokens: 10 },
      ],
    })
    const all = heavyFrom(breakdown({ skills: skills(92) }, [{ name: 'Skills', tokens: 7_554, kind: 'used' }])).find(i => i.name === 'スキル一覧')
    expect(all?.details).toEqual(['92 個', 'dataviz  482 tok', 'docs  343 tok', 'review（gstack）  300 tok'])
    expect(all?.hint).toContain('disable-model-invocation: true')

    const cut = heavyFrom(breakdown({ skills: skills(60) }, [{ name: 'Skills', tokens: 7_554, kind: 'used' }])).find(i => i.name === 'スキル一覧')
    expect(cut?.details?.[0]).toBe('92 個（一覧に入るのは 60 個で、残りはモデルに見えていません）')
  })

  test('MCP tools are grouped by server, noting what is not loaded yet', () => {
    const tool = (serverName: string, tokens: number, isLoaded: boolean) => ({ name: `mcp__${serverName}__t`, serverName, tokens, isLoaded })
    const items = heavyFrom(
      breakdown(
        { mcpTools: [tool('gbrain', 3_000, true), tool('gbrain', 4_000, false), tool('notion', 1_000, true), tool('gbrain', 5_000, false)] },
        [{ name: 'MCP tools', tokens: 13_000, kind: 'used' }],
      ),
    )
    const mcp = items.find(i => i.name === 'MCP のツール定義')
    // What is held back costs nothing yet: the line says what is in the window now and what using them would add.
    expect(mcp?.details).toEqual(['gbrain: 3 個  いま 3k tok（未読み込み 2 個は、使うときに ＋9k）', 'notion: 1 個  いま 1k tok'])
    expect(mcp?.hint).toContain('/mcp')
  })

  test('one thing the engine lists in two rows is one line here, its tokens added and its details given once', () => {
    const items = heavyFrom(
      breakdown(
        { mcpTools: [{ name: 'mcp__g__t', serverName: 'g', tokens: 5_000, isLoaded: false }] },
        [
          { name: 'MCP tools', tokens: 846, kind: 'used' },
          { name: 'MCP tools (loaded on demand)', tokens: 631, kind: 'used' },
          { name: 'Messages', tokens: 3_000, kind: 'used' },
        ],
      ),
    )
    expect(items.filter(i => i.name === 'MCP のツール定義').length).toBe(1)
    const mcp = items.find(i => i.name === 'MCP のツール定義')
    expect(mcp?.tokens).toBe(1_477)
    expect(mcp?.details).toEqual(['g: 1 個  いま 0 tok（未読み込み 1 個は、使うときに ＋5k）'])
  })

  test('custom agents and the command list are counted too; an empty breakdown adds no details', () => {
    const items = heavyFrom(
      breakdown(
        {
          agents: [
            { agentType: 'reviewer', source: 'plugin', tokens: 800 },
            { agentType: 'planner', source: 'projectSettings', tokens: 1_900 },
          ],
          slashCommands: { totalCommands: 92, includedCommands: 92, tokens: 1_417 },
        },
        [
          { name: 'Custom agents', tokens: 2_700, kind: 'used' },
          { name: 'Slash commands', tokens: 1_417, kind: 'used' },
          { name: 'System prompt', tokens: 2_300, kind: 'used' },
        ],
      ),
    )
    expect(items.find(i => i.name === 'カスタムエージェント')?.details).toEqual(['planner  1.9k tok', 'reviewer  800 tok'])
    expect(items.find(i => i.name === 'スラッシュコマンド一覧')?.details).toEqual(['92 個'])
    expect(items.find(i => i.name === 'システムプロンプト')?.details).toBeUndefined()
  })

  test('the pane draws the details under what they belong to', async ($, on) => {
    engine(on, {
      breakdownExtras: {
        memoryFiles: [{ path: '/work/app/CLAUDE.md', type: 'Project', tokens: 4_200 }],
        categories: [
          { name: 'Messages', tokens: 3_000, color: 'x', kind: 'used' },
          { name: 'Memory files', tokens: 4_200, color: 'x', kind: 'used' },
          { name: 'Free space', tokens: 150_000, color: 'x', kind: 'free' },
        ],
      },
    })
    await $.session.start(START)
    const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /Project: app\/CLAUDE\.md {2}4\.2k tok/ })).toBeDefined()
  })
})
