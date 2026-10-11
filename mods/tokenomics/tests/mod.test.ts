import type { SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { FACE } from '../hooks/lib/mascot'

import { MODEL_SWITCH, SURFACES, bandProps, engine, frameColor, measure, paneProps } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const RUN = {
  command: 'tokenomics',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

const withBreakdown = (percent: number): SessionUsage =>
  ({
    startedAt: 0,
    rateLimits: [],
    context: {
      window: 200_000,
      percent,
      tokens: percent * 2000,
      breakdown: {
        categories: [
          { name: 'Messages', tokens: 30_000, color: 'x', kind: 'used' },
          { name: 'MCP tools', tokens: 14_000, color: 'x', kind: 'used' },
          { name: 'Free space', tokens: 100_000, color: 'x', kind: 'free' },
        ],
        isAutoCompactEnabled: false,
      },
    },
  }) as unknown as SessionUsage

test('session.start registers /tokenomics, and the starter status line is gone', async ($, on) => {
  const calls = engine(on)

  await $.session.start(START)

  expect(calls.registered).toEqual(['tokenomics'])
  expect(calls.statuses).toEqual([])
})

test('session.start takes the engine’s figures, so a resumed session opens already knowing its fill', async ($, on) => {
  engine(on, { usage: { startedAt: 0, context: { window: 200_000, percent: 64, tokens: 128_000 }, rateLimits: [] } })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /64%/ })).toBeDefined()
})

test('/tokenomics opens the pane and, when it is seated, adds no transcript line', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  const ran = await $.command.run(RUN)
  expect(calls.opened).toEqual(['tokenomics'])
  expect(ran.text).toBeUndefined()
})

test('/tokenomics on a terminal too narrow for a pane says the same thing as text', async ($, on) => {
  const calls = engine(on, { isPlaced: false })
  await $.session.start(START)
  await $.session.measure(measure.context(78))

  const ran = await $.command.run(RUN)
  // The suggestion tried a dialog first and found no room; then the command tried the pane.
  expect(calls.opened).toEqual(['tokenomics-offer', 'tokenomics'])
  expect(ran.text).toContain('トークン消費')
  expect(ran.text).toContain('会話が重くなってきました')
  expect(ran.text).toContain('受け入れると')
  expect(ran.text).toContain('メモに残してから要約')
})

test('the pane says "nothing to do" when that is true, and never leaves the page blank', async ($, on) => {
  engine(on)
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...paneProps, surface })
    expect(await ui.find({ type: 'Text', text: '今は何もしなくて大丈夫です。' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: FACE.good })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'いまの状態' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '節約のコツ' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
  }
})

test('the pane names what to do now, can do it, and shows what is heavy', async ($, on) => {
  const calls = engine(on, { usage: withBreakdown(80) })
  await $.session.start(START)
  await $.session.measure(measure.context(80))

  const ui = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '会話が重くなってきました' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: FACE.heavy })).toBeDefined()
  // Breakdown was asked for at start, in its free local form.
  expect(await ui.find({ type: 'Text', text: '会話履歴' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /使っていないサーバーは \/mcp/ })).toBeDefined()

  await ui.press({ key: 'standing-compact-70-accept' })
  expect(calls.compacts).toBe(1)
})

test('with the pane short on rows the tips make room for what matters', async ($, on) => {
  engine(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...paneProps, viewport: { columns: 100, rows: 18 }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '節約のコツ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'いまの状態' })).toBeDefined()
})

test('turns of a subagent or an interrupted turn do not count as this conversation’s', async ($, on) => {
  engine(on)
  const usage = { input_tokens: 5000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'm' }
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'sub', reason: 'answer', usage })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer', usage })
  expect(await ui.find({ type: 'Text', text: '5.5k tok' })).toBeDefined()
})

test('a large tool result is named in the band, and the next prompt lets it go', async ($, on) => {
  engine(on)
  on('tool.call', (_$, e) => ({ result: { type: 'text' }, text: 'x'.repeat(45_000), isReadOnly: true, ref: 1 }) as never)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.tool.call({ tool: 'Read', tool_use_id: 'tu_1', file_path: '/repo/src/huge-generated-file.ts' } as never)
  expect(await ui.find({ type: 'Text', text: /ファイル読み込みの出力が大きめでした（約15k tok）/ })).toBeDefined()
  expect(await ui.find({ key: 'later' })).toBeDefined()
  // Nothing to compact away: advice about a habit offers no button for it.
  expect(await ui.find({ key: 'compact' })).toBeUndefined()

  await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } } as never)
  expect(await ui.find({ type: 'Text', text: /出力が大きめ/ })).toBeUndefined()
})

test('small tool results and a subagent’s are not worth a word', async ($, on) => {
  engine(on)
  on('tool.call', (_$, e) => ({ result: { type: 'text' }, text: 'x'.repeat(e.tool_use_id === 'small' ? 900 : 45_000), isReadOnly: true, ref: 1 }) as never)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.tool.call({ tool: 'Read', tool_use_id: 'small', file_path: '/a.ts' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'sub', agentId: 'sub-1', file_path: '/b.ts' } as never)
  expect(await ui.find({ type: 'Text', text: /出力が大きめ/ })).toBeUndefined()
})

test('after a long pause the band speaks only when the turn shows the cache really lapsed', async ($, on) => {
  const calls = engine(on)
  const turn = (cacheWrite: number, cacheRead: number) => ({
    input_tokens: 900,
    output_tokens: 300,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    model: 'm',
  })
  const done = (id: string, usage: ReturnType<typeof turn>) =>
    $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage })
  const ask = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(30))
  await done('t1', turn(0, 60_000))

  // Back within a couple of minutes: nothing to say.
  await calls.clock.advance(2 * 60_000)
  await ask('and then?')
  await done('t2', turn(1000, 60_000))
  expect(await ui.find({ type: 'Text', text: /しばらく空いたため/ })).toBeUndefined()

  // A long pause, but the cache held (it may be a 1-hour cache): the mod does not guess.
  await calls.clock.advance(6 * 60_000)
  await ask('back again')
  await done('t3', turn(1000, 60_000))
  expect(await ui.find({ type: 'Text', text: /しばらく空いたため/ })).toBeUndefined()

  // A long pause and the whole conversation written back: now it is a fact, with its size.
  await calls.clock.advance(6 * 60_000)
  await ask('back once more')
  await done('t4', turn(58_000, 0))
  expect(await ui.find({ type: 'Text', text: /しばらく空いたため、会話の読み直しが発生しました（約58k tok）/ })).toBeDefined()

  // And the next prompt lets it go.
  await ask('thanks')
  expect(await ui.find({ type: 'Text', text: /しばらく空いたため/ })).toBeUndefined()
})

test('a schedule firing after a long pause reads a lapsed cache all the same: the band says so, though it is not the person’s prompt', async ($, on) => {
  const calls = engine(on)
  const turn = (fresh: number, read: number) => ({
    input_tokens: 900,
    output_tokens: 300,
    cache_creation_input_tokens: fresh,
    cache_read_input_tokens: read,
    model: 'm',
  })
  const done = (id: string, usage: ReturnType<typeof turn>) =>
    $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage })
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(30))
  await done('t1', turn(0, 60_000))
  await calls.clock.advance(12 * 60_000)
  await $.prompt.submit({ text: 'check the build', wait: false, origin: { kind: 'scheduled-trigger' } } as never)
  await done('t2', turn(58_000, 0))
  expect(await ui.find({ type: 'Text', text: /しばらく空いたため、会話の読み直しが発生しました（約58k tok）/ })).toBeDefined()
})

test('a slash command is not a turn: the pause is not held against it', async ($, on) => {
  const calls = engine(on)
  const usage = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 60_000, model: 'm' }
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(30))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage })
  await calls.clock.advance(10 * 60_000)
  await $.prompt.submit({ text: '/tokenomics', wait: false, origin: { kind: 'composer' } } as never)
  // The next real turn writes the whole context back, as a lapsed cache would, but no pause was noted for it.
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage: { ...usage, cache_creation_input_tokens: 58_000 } })
  expect(await ui.find({ type: 'Text', text: /しばらく空いたため/ })).toBeUndefined()
})

test('a compaction the person typed, or the engine ran, lowers the band too, and takes the suggestion down', async ($, on) => {
  const calls = engine(on, { compacted: { tokensBefore: 160_000, tokensAfter: 40_000 } })
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(80))
  expect(await frameColor(ui)).toBe('warning')
  expect(calls.opened).toEqual(['tokenomics-offer'])

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(calls.compacts).toBe(1)
  expect(await ui.find({ type: 'Text', text: /20%/ })).toBeDefined()
  expect(await frameColor(ui)).toBe('claude')
  // It was a suggestion for a heavy conversation; the conversation is no longer heavy.
  expect(calls.closed).toEqual(['tokenomics-offer'])
})

test('/clear starts the band over but keeps the money', async ($, on) => {
  engine(on)
  const usage = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'm' }
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  // 150k of the 160k the engine compacts at: the gauge counts toward that.
  await $.session.measure({ ...measure.context(75), cost: { usd: 3 } })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage })
  expect(await ui.find({ type: 'Text', text: /93%/ })).toBeDefined()

  await $.session.end({ reason: 'clear' } as never)
  expect(await ui.find({ type: 'Text', text: /0%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$3.00' })).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
})

const SWITCH = MODEL_SWITCH

test('switching model on a warm, big conversation asks first, with the price', async ($, on) => {
  on('classic.PreModelSwitch', () => ({}))

  const asked = await $.classic.PreModelSwitch(SWITCH as never)
  expect(asked.permissionDecision).toBe('ask')
  expect(asked.permissionDecisionReason).toContain('$0.90')
  expect(asked.permissionDecisionReason).toContain('120k')
})

test('on a subscription the same question is asked in tokens and limit, never in dollars', async ($, on) => {
  engine(on)
  on('classic.PreModelSwitch', () => ({}))
  await $.session.measure({ ...measure.context(60), rateLimits: [{ kind: 'five_hour', percentUsed: 30 }], changed: ['rateLimits'] })

  const asked = await $.classic.PreModelSwitch(SWITCH as never)
  expect(asked.permissionDecision).toBe('ask')
  expect(asked.permissionDecisionReason).not.toContain('$')
  expect(asked.permissionDecisionReason).toContain('120k tok')
  expect(asked.permissionDecisionReason).toContain('上限')
})

test('switching model asks nothing when nothing is lost', async ($, on) => {
  on('classic.PreModelSwitch', () => ({}))

  for (const change of [
    { prompt_cache_warm: false },
    { estimated_cache_write_usd: 0.01 },
    { source: 'sdk' },
    { source: 'resume' },
    { to_model: 'claude-opus-5-5' },
  ]) {
    const decided = await $.classic.PreModelSwitch({ ...SWITCH, ...change } as never)
    expect(decided.permissionDecision).toBeUndefined()
  }
})
