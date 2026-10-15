import type { SessionMessage } from 'claude-code'
import { type Engine, expect, test } from 'claude-code/testing'

import { FACE } from '../hooks/lib/mascot'

import { parseLedger } from '../hooks/lib/core/ledger'
import { MODEL_SWITCH, SURFACES, answer, bandProps, engine, measure, offerPaneProps, paneProps, runStep, settingsPaneProps, type Calls } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const DIALOG = 'tokenomics-offer'
const TOOL = { plugin: 'tokenomics', tier: 'user' } as const

const transcript: SessionMessage[] = [
  { role: 'user', text: 'Add a dark mode toggle', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/theme.ts' } }] },
  { role: 'assistant', text: 'Done.', toolUses: [] },
]

const compactInput = (over: { trigger?: 'manual' | 'auto' | 'plugin' | 'precompute'; instructions?: string; agentId?: string } = {}) =>
  ({ trigger: over.trigger ?? 'manual', instructions: over.instructions, agentId: over.agentId, messages: transcript }) as never

const SMALL = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'm' }

type Driver = Engine
const ask = ($: Driver, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
const done = ($: Driver, id: string, usage = SMALL) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage } as never)

/** `n` turns in a row, each answering `text`. */
const turns = async ($: Driver, n: number, text: string) => {
  for (let i = 0; i < n; i += 1) {
    await ask($, text)
    await done($, `t${i}`)
  }
}

const dialogs = (calls: Calls): number => calls.opened.filter(id => id === DIALOG).length

/** A conversation of `percent` of a 200k window, with a limit on top when asked. */
const state = (percent: number, limit?: number) => ({
  ...measure.context(percent),
  rateLimits: limit === undefined ? [] : [{ kind: 'five_hour', percentUsed: limit }],
  changed: ['context', 'rateLimits'] as ['context', 'rateLimits'],
})

const bigRead = (on: Parameters<typeof engine>[0]) =>
  on('tool.call', () => ({ result: { type: 'text' }, text: 'x'.repeat(45_000), isReadOnly: true, ref: 1 }) as never)

const log = (failAt = 1000) =>
  Array.from({ length: 2000 }, (_, i) => (i === failAt ? 'FAIL src/auth.test.ts > rejects a bad password' : `ok test ${i} ${'x'.repeat(10)}`)).join('\n')

test('a heavy conversation is put to the person as a dialog, once', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  await $.session.measure(state(78))
  // It does not ask for the keyboard: right after a reply is when people start typing.
  expect(calls.openArgs.filter(a => a.id === DIALOG)).toEqual([{ id: DIALOG, title: '提案', closeOnEscape: true }])
  expect(calls.openArgs.find(a => a.id === DIALOG)?.focus).toBeUndefined()

  for (const surface of SURFACES) {
    const dialog = await $.ui.mount({ ...offerPaneProps, surface })
    expect(await dialog.find({ type: 'Text', text: '会話が重くなってきました' })).toBeDefined()
    expect(await dialog.find({ type: 'Text', text: /返信のたびに全体を読み直す/ })).toBeDefined()
    expect(await dialog.find({ type: 'Text', text: /メモに残してから要約します/ })).toBeDefined()
    expect(await dialog.find({ key: 'offer-accept' }).then(b => b?.props.label)).toBe('要約する')
    expect(await dialog.find({ key: 'offer-later' }).then(b => b?.props.label)).toBe('あとで')
    expect(await dialog.find({ key: 'offer-mute' }).then(b => b?.props.label)).toBe('もう出さない')
    await dialog.unmount()
  }

  // The same spell: not asked again.
  await $.session.measure(state(79))
  expect(dialogs(calls)).toBe(1)
})

test('Enter on the dialog, once it has the keys, lands on 「あとで」, never on something that carries out', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.session.measure(state(78))

  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect((await dialog.find({ key: 'offer-later' }))?.props.autoFocus).toBe(true)
  expect((await dialog.find({ key: 'offer-accept' }))?.props.autoFocus).toBeUndefined()
})

test('accepting a compaction leaves a note, compacts once, and keeps leaving notes from then on', async ($, on) => {
  const calls = engine(on, {
    tmp: '/t',
    sessionId: 's',
    messages: transcript,
    compacted: { tokensBefore: 160_000, tokensAfter: 40_000 },
  })
  await $.session.start(START)
  await $.session.measure(state(80))
  await answer($ as never, 'accept')

  expect(calls.compacts).toBe(1)
  expect(calls.writes.map(w => w.path)).toEqual(['/t/claude-tokenomics/s/handoff-1.md'])
  expect(calls.writes[0]?.text).toContain('Add a dark mode toggle')
  expect(calls.compactions.at(-1)?.instructions).toContain('Details: /t/claude-tokenomics/s/handoff-1.md')
  expect(calls.toasts.at(-1)).toBe(`${FACE.good} 要約して軽くしました（160k → 40k tok）`)
  expect(calls.closed).toContain(DIALOG)

  // A compaction the person types, or the engine runs, is preceded by a note now too.
  await $.session.compact(compactInput({ instructions: 'focus on the plan' }))
  expect(calls.writes.at(-1)?.path).toBe('/t/claude-tokenomics/s/handoff-2.md')
  expect(calls.compactions.at(-1)?.instructions).toContain('focus on the plan')
  expect(calls.compactions.at(-1)?.instructions).toContain('handoff-2.md')

  // A precomputed summary gets a note of its own that does not use up a number.
  await $.session.compact(compactInput({ trigger: 'precompute' }))
  expect(calls.writes.at(-1)?.path).toBe('/t/claude-tokenomics/s/handoff-pre.md')
  await $.session.compact(compactInput())
  expect(calls.writes.at(-1)?.path).toBe('/t/claude-tokenomics/s/handoff-3.md')

  // A subagent's compaction is not this conversation's.
  const before = calls.writes.length
  await $.session.compact(compactInput({ agentId: 'sub-1', instructions: 'sub' }))
  expect(calls.writes).toHaveLength(before)
  expect(calls.compactions.at(-1)?.instructions).toBe('sub')
})

test('a note that cannot be written does not stop the compaction', async ($, on) => {
  const calls = engine(on, { isWriteBroken: true })
  await $.session.start(START)
  await $.session.measure(state(80))
  await answer($ as never, 'accept')

  expect(calls.compacts).toBe(1)
  expect(calls.compactions.at(-1)?.instructions).toBeUndefined()
  expect(calls.toasts.at(-1)).toContain('要約して軽くしました')
})

test('"あとで" lets it go for the rest of the spell; a new spell is offered anew, and 90 is more urgent than 70', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  await $.session.measure(state(75))
  await answer($ as never, 'later')
  expect(calls.compacts).toBe(0)
  expect(calls.closed).toContain(DIALOG)

  await $.session.measure(state(78))
  expect(dialogs(calls)).toBe(1)

  await $.session.measure(state(95))
  expect(dialogs(calls)).toBe(2)
  const urgent = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await urgent.find({ type: 'Text', text: '会話がいっぱいに近づいています' })).toBeDefined()
  await urgent.unmount()
  await answer($ as never, 'later')

  await $.session.measure(state(20))
  await $.session.measure(state(75))
  expect(dialogs(calls)).toBe(3)
})

test('"もう出さない" is remembered past the session, and the pane can bring it back', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(state(75))
  await answer($ as never, 'mute')

  expect(calls.store.get('mutedOffers')).toEqual(['compact'])
  expect(calls.toasts.at(-1)).toContain('ペインから再開できます')

  await $.session.measure(state(10))
  await $.session.measure(state(80))
  expect(dialogs(calls)).toBe(1)

  const settings = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await settings.find({ type: 'Text', text: '止めている提案' })).toBeDefined()
  expect(await settings.find({ type: 'Text', text: '要約の提案' })).toBeDefined()
  // Muted, it is not on the analysis pane's list of things to do either, nor listed there as put off.
  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ key: 'standing-compact-70-accept' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '止めている提案' })).toBeUndefined()

  await settings.press({ key: 'resume-compact' })
  expect(calls.store.get('mutedOffers')).toEqual([])
  await $.session.measure(state(10))
  await $.session.measure(state(80))
  expect(dialogs(calls)).toBe(2)
})

test('a kind muted in an earlier session stays quiet in this one; a stored list of the wrong shape mutes nothing', async ($, on) => {
  const quiet = engine(on, { store: { mutedOffers: ['compact', 'nonsense'] } })
  await $.session.start(START)
  await $.session.measure(state(85))
  expect(dialogs(quiet)).toBe(0)
})

test('a stored list of the wrong shape mutes nothing', async ($, on) => {
  const calls = engine(on, { store: { mutedOffers: 'garbage' } })
  await $.session.start(START)
  await $.session.measure(state(85))
  expect(dialogs(calls)).toBe(1)
})

test('nothing is put to the person while a turn runs; it waits for the turn to end', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.measure(state(85))
  expect(dialogs(calls)).toBe(0)

  await done($, 't1')
  expect(dialogs(calls)).toBe(1)
})

test('a prompt typed meanwhile takes the suggestion down, a slash command does not', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(state(80))

  await ask($, '/tokenomics')
  expect(calls.closed).toEqual([])
  await ask($, 'next, fix the login bug')
  expect(calls.closed).toEqual([DIALOG])
})

test('a suggestion put off can still be taken up from the pane', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(state(80))
  await answer($ as never, 'later')

  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '会話が重くなってきました' })).toBeDefined()
  await pane.press({ key: 'standing-compact-70-accept' })
  expect(calls.compacts).toBe(1)
})

test('with no suggestion on screen, the dialog says so rather than drawing nothing', async ($, on) => {
  engine(on)
  await $.session.start(START)

  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: 'いま、提案はありません。' })).toBeDefined()
})

test('small turns on a model that thinks hard propose a lower effort; accepted, it lowers the main conversation only', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' } })
  await $.session.start(START)
  const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await runStep($ as never, { effort: 'xhigh' })
  await turns($, 2, 'ok')
  expect(dialogs(calls)).toBe(0)
  await turns($, 1, 'ok')
  expect(dialogs(calls)).toBe(1)
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: '簡単な作業が続いています' })).toBeDefined()
  expect(await dialog.find({ key: 'offer-accept' }).then(b => b?.props.label)).toBe('ふつうにする')
  await dialog.unmount()

  // Before it is accepted the step goes out as it came.
  await runStep($ as never, { effort: 'xhigh' })
  expect(calls.steps.at(-1)?.effort).toBe('xhigh')

  await answer($ as never, 'accept')
  expect(await band.find({ type: 'Text', text: '節約中: effort ふつう' })).toBeDefined()

  await runStep($ as never, { effort: 'xhigh' })
  expect(calls.steps.at(-1)?.effort).toBe('medium')
  await runStep($ as never, { effort: 'low' })
  expect(calls.steps.at(-1)?.effort).toBe('low')
  // A subagent keeps the effort it was defined with.
  await runStep($ as never, { effort: 'xhigh', agentId: 'sub-1' })
  expect(calls.steps.at(-1)).toMatchObject({ effort: 'xhigh', agentId: 'sub-1' })
  // A model with no effort is sent none.
  await runStep($ as never, {})
  expect(calls.steps.at(-1)?.effort).toBeUndefined()

  // The pane lists it, and ends it.
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /考える深さ: ふつうに制限中/ })).toBeDefined()
  await pane.press({ key: 'stop-effort' })
  await runStep($ as never, { effort: 'max' })
  expect(calls.steps.at(-1)?.effort).toBe('max')
  expect(await band.find({ type: 'Text', text: /節約中/ })).toBeUndefined()
})

test('what an agent or a schedule sends in does not count as the person’s small requests', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' } })
  await $.session.start(START)
  await runStep($ as never, { effort: 'xhigh' })

  await turns($, 2, 'ok')
  // Five hand-backs, each a short turn: they are not the person asking for little.
  for (let i = 0; i < 5; i += 1) {
    await $.prompt.submit({ text: '<agent-message from="a1">[Subagent hand-back] ok', wait: false, origin: { kind: 'peer' } } as never)
    await done($, `h${i}`)
  }
  expect(dialogs(calls)).toBe(0)

  // The person's third small request is the third.
  await turns($, 1, 'ok')
  expect(dialogs(calls)).toBe(1)
})

test('no lower effort is proposed when the effort is already modest', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' } })
  await $.session.start(START)

  await runStep($ as never, { effort: 'medium' })
  await turns($, 5, 'ok')
  expect(dialogs(calls)).toBe(0)
})

test('a big turn breaks the run of small ones', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' } })
  await $.session.start(START)

  await runStep($ as never, { effort: 'xhigh' })
  await turns($, 2, 'ok')
  // A long prompt is not a small turn.
  await turns($, 1, 'please go through the whole authentication module and explain every edge case in detail')
  await turns($, 2, 'ok')
  expect(dialogs(calls)).toBe(0)

  await turns($, 1, 'ok')
  expect(dialogs(calls)).toBe(1)
})

test('a large read proposes nothing and registers no helper: the digest and the scout are what deal with it', async ($, on) => {
  const calls = engine(on)
  bigRead(on)
  await $.session.start(START)

  await $.tool.call({ tool: 'Read', tool_use_id: 'tu_1', file_path: '/repo/src/huge-generated-file.ts' } as never)
  await done($, 't1')

  expect(dialogs(calls)).toBe(0)
  expect(calls.agents).toEqual([])
})

test('a lighter model is proposed while the conversation is small and a limit is running out; accepted, it is switched', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus' }, conversationTokens: 3_000 })
  await $.session.start(START)

  // The window already holds 30k before the first word: it is the conversation's own size that counts.
  await $.session.measure(state(15, 72))
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: '5時間の上限が近づいています' })).toBeDefined()
  expect(await dialog.find({ type: 'Text', text: /会話が小さい（約3k tok）.*約30k tok で済みます/ })).toBeDefined()
  expect(await dialog.find({ key: 'offer-accept' }).then(b => b?.props.label)).toBe('Sonnet にする')
  await dialog.unmount()

  await answer($ as never, 'accept')
  expect(calls.configSets).toEqual([{ key: 'model', value: 'sonnet' }])
  expect(calls.toasts.at(-1)).toContain('終了するとき opus に戻します')
  expect(calls.store.get('pendingModel')).toEqual({ previous: 'opus', switchedTo: 'sonnet' })

  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /モデルを切り替え中（元: opus）/ })).toBeDefined()
  expect(await pane.find({ key: 'stop-model' }).then(b => b?.props.label)).toBe('元に戻す')
  await pane.press({ key: 'stop-model' })
  expect(calls.configSets.at(-1)).toEqual({ key: 'model', value: 'opus' })
  expect(calls.store.get('pendingModel')).toBeUndefined()
})

test('accepting the model offer is not asked about again by the mod’s own switch warning', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus' } })
  on('classic.PreModelSwitch', () => ({}))
  await $.session.start(START)
  await $.session.measure(state(4, 72))

  // The engine raises its switch warning while the accepted move is made: the person has been told the cost.
  let during: { permissionDecision?: string } | undefined
  calls.beforeSet = async () => {
    during = await $.classic.PreModelSwitch(MODEL_SWITCH as never)
  }
  await answer($ as never, 'accept')
  calls.beforeSet = undefined

  expect(calls.configSets).toEqual([{ key: 'model', value: 'sonnet' }])
  expect(during?.permissionDecision).toBeUndefined()
  // The person's own switches are asked about again afterwards.
  expect((await $.classic.PreModelSwitch(MODEL_SWITCH as never)).permissionDecision).toBe('ask')
})

test('"default" is read as the model that answered: a default that is already Sonnet is offered Haiku, not Sonnet', async ($, on) => {
  engine(on, { config: { model: 'default' } })
  await $.session.start(START)
  await done($, 't0', { ...SMALL, model: 'claude-sonnet-5-5' })

  await $.session.measure(state(4, 72))
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ key: 'offer-accept' }).then(b => b?.props.label)).toBe('Haiku にする')
})

test('a big conversation, or one not yet measured, is not moved to a lighter model; nor is the lightest', async ($, on) => {
  const big = engine(on, { config: { model: 'opus' }, conversationTokens: 60_000 })
  await $.session.start(START)
  await $.session.measure(state(40, 90))
  expect(big.configSets).toEqual([])
  expect(dialogs(big)).toBe(0)
})

test('the lightest model has nothing lighter to propose', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' } })
  await $.session.start(START)
  await $.session.measure(state(4, 90))
  expect(dialogs(calls)).toBe(0)
})

test('a model the engine refuses leaves everything as it was, and says why', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus', setDeny: 'not allowed by policy' } })
  await $.session.start(START)
  await $.session.measure(state(4, 72))
  await answer($ as never, 'accept')

  expect(calls.toasts.at(-1)).toContain('not allowed by policy')
  expect(calls.store.get('pendingModel')).toBeUndefined()
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ key: 'stop-model' })).toBeUndefined()
})

/** The person accepts a move to a lighter model. */
const moveToSonnet = async ($: Driver, calls: Calls) => {
  await $.session.start(START)
  await $.session.measure(state(4, 72))
  await answer($ as never, 'accept')
  expect(calls.configSets).toEqual([{ key: 'model', value: 'sonnet' }])
}

test('when the session ends the model is put back, and the exit is not held up by the mod’s own warning', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus' } })
  on('classic.PreModelSwitch', () => ({}))
  await moveToSonnet($, calls)

  // While the mod is putting the model back, the engine raises its switch warning: it must pass.
  let during: { permissionDecision?: string } | undefined
  calls.beforeSet = async () => {
    during = await $.classic.PreModelSwitch(MODEL_SWITCH as never)
  }
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  calls.beforeSet = undefined

  expect(calls.configSets.at(-1)).toEqual({ key: 'model', value: 'opus' })
  expect(during?.permissionDecision).toBeUndefined()
  expect(calls.store.get('pendingModel')).toBeUndefined()
  // And the person's own switches are asked about again afterwards.
  expect((await $.classic.PreModelSwitch(MODEL_SWITCH as never)).permissionDecision).toBe('ask')
})

test('/clear goes on in the same session, so the model stays where the person put it', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus' } })
  await moveToSonnet($, calls)

  await $.session.end({ reason: 'clear' } as never)
  expect(calls.configSets).toEqual([{ key: 'model', value: 'sonnet' }])
  expect(calls.store.get('pendingModel')).toEqual({ previous: 'opus', switchedTo: 'sonnet' })
})

test('a model the person chose themselves afterwards is left alone at the end', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus' } })
  await moveToSonnet($, calls)
  // The person picks another model in the menu themselves.
  await $.config.set({ key: 'model', value: 'haiku', previous: 'sonnet', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } } as never)
  const before = calls.configSets.length

  await $.session.end({ reason: 'other' } as never)
  expect(calls.configSets).toHaveLength(before)
  expect(calls.store.get('pendingModel')).toBeUndefined()
})

test('a switch left behind by a session that ended abruptly is undone at the next start, with a word about it', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' }, store: { pendingModel: { previous: 'opus', switchedTo: 'haiku' } } })

  await $.session.start(START)
  expect(calls.configSets).toEqual([{ key: 'model', value: 'opus' }])
  expect(calls.toasts.some(t => t.includes('前回') && t.includes('opus'))).toBe(true)
  expect(calls.store.get('pendingModel')).toBeUndefined()
})

test('a leftover is only cleared, never applied, when the model has been changed since; a wrong shape is ignored', async ($, on) => {
  const changed = engine(on, { config: { model: 'sonnet' }, store: { pendingModel: { previous: 'opus', switchedTo: 'haiku' } } })
  await $.session.start(START)
  expect(changed.configSets).toEqual([])
  expect(changed.store.get('pendingModel')).toBeUndefined()
})

test('a pending value of the wrong shape is ignored, and with nothing left behind starting a session touches no setting', async ($, on) => {
  const calls = engine(on, { config: { model: 'opus' }, store: { pendingModel: 'garbage' } })
  await $.session.start(START)
  expect(calls.configSets).toEqual([])
})

test('with autocompact off it is proposed after the compaction; accepted, it is on, notes are on, and it says it is saved', async ($, on) => {
  const calls = engine(on, { config: { autoCompact: false }, tmp: '/t', sessionId: 's' })
  await $.session.start(START)

  await $.session.measure(state(80))
  await answer($ as never, 'later')
  expect(dialogs(calls)).toBe(1)
  await $.session.measure(state(81))
  expect(dialogs(calls)).toBe(2)
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: '自動要約がオフです' })).toBeDefined()
  await dialog.unmount()

  await answer($ as never, 'accept')
  expect(calls.configSets).toEqual([{ key: 'autoCompact', value: true }])
  expect(calls.toasts.at(-1)).toContain('設定に保存されます')

  // The notes that make it safe to let the engine compact are on.
  await $.session.compact(compactInput())
  expect(calls.writes.at(-1)?.path).toBe('/t/claude-tokenomics/s/handoff-1.md')
})

test('a locked autocompact row proposes nothing, and a refused change says so', async ($, on) => {
  const locked = engine(on, { config: { autoCompact: false, isAutoCompactLocked: true } })
  await $.session.start(START)
  await $.session.measure(state(80))
  await answer($ as never, 'later')
  await $.session.measure(state(81))
  expect(dialogs(locked)).toBe(1)
})

test('a refused autocompact change says so and changes nothing', async ($, on) => {
  const calls = engine(on, { config: { autoCompact: false, setDeny: 'managed' } })
  await $.session.start(START)
  await $.session.measure(state(80))
  await answer($ as never, 'later')
  await $.session.measure(state(81))
  await answer($ as never, 'accept')

  expect(calls.toasts.at(-1)).toContain('managed')
})

test('a commit ends a piece of work: starting fresh is proposed once the turn ends, and accepting only types /clear', async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: 'ok', isReadOnly: true, ref: 1 }) as never)
  await $.session.start(START)
  // The session began small and the conversation has grown since: its size is learned when it is needed.
  calls.conversation = 40_000
  await $.session.measure(state(30))

  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'git commit -m "add the toggle"' } as never)
  // The turn is not over: not yet.
  await $.turn.start({ text: 'commit it', turnId: 't1' } as never)
  expect(dialogs(calls)).toBe(0)
  await done($, 't1')
  expect(dialogs(calls)).toBe(1)
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: 'ひと区切りつきました' })).toBeDefined()
  await dialog.unmount()

  await answer($ as never, 'accept')
  expect(calls.filled).toEqual(['/clear'])
  expect(calls.toasts.at(-1)).toContain('Enter')
})

test('starting fresh never overwrites what the person was typing', async ($, on) => {
  const calls = engine(on, { draft: 'fix the login bug', conversationTokens: 40_000 })
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: 'ok', isReadOnly: true, ref: 1 }) as never)
  await $.session.start(START)
  await $.session.measure(state(30))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'gh pr create --fill' } as never)
  await done($, 't1')
  await answer($ as never, 'accept')

  expect(calls.filled).toEqual([])
  expect(calls.toasts.at(-1)).toContain('/clear')
})

test('a failed commit, a small conversation, and an ordinary command are no break', async ($, on) => {
  const calls = engine(on, { config: { model: 'haiku' }, conversationTokens: 5_000 })
  let failed = false
  on('tool.call', () => ({ result: { stdout: 'x', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: 'x', isError: failed, isReadOnly: true, ref: 1 }) as never)
  await $.session.start(START)

  await $.session.measure(state(5))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'git commit -m x' } as never)
  await done($, 't1')
  expect(dialogs(calls)).toBe(0)

  // The next prompt starts a new turn: a break in the last one is forgotten.
  await ask($, 'now a second thing')
  calls.conversation = 40_000
  await $.session.measure(state(30))
  failed = true
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'git commit -m x' } as never)
  await done($, 't2')
  failed = false
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c', command: 'git status' } as never)
  await done($, 't3')
  expect(dialogs(calls)).toBe(0)
})

test('a change of folder is proposed at once when no turn is running, and not again in the session', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  calls.conversation = 40_000
  await $.session.measure(state(30))

  await $.classic.CwdChanged({ old_cwd: '/a', new_cwd: '/b' } as never)
  expect(dialogs(calls)).toBe(1)
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: '作業フォルダが変わりました' })).toBeDefined()
  await dialog.unmount()
  await answer($ as never, 'later')

  await $.classic.CwdChanged({ old_cwd: '/b', new_cwd: '/c' } as never)
  expect(dialogs(calls)).toBe(1)
})

test('prompt suggestions are mentioned after a few turns, and turned off on acceptance', async ($, on) => {
  const calls = engine(on, { config: { suggest: true } })
  await $.session.start(START)
  const long = 'please walk through the whole authentication module and explain every edge case in detail'

  await turns($, 4, long)
  expect(dialogs(calls)).toBe(0)
  await turns($, 1, long)
  expect(dialogs(calls)).toBe(1)
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: /次の入力の候補/ })).toBeDefined()
  await dialog.unmount()

  await answer($ as never, 'accept')
  expect(calls.configSets).toEqual([{ key: 'promptSuggestionEnabled', value: false }])
  expect(calls.toasts.at(-1)).toContain('設定に保存されます')
})

for (const suggest of [false, 'locked', 'absent'] as const) {
  test(`prompt suggestions are not mentioned when the row is ${suggest === false ? 'already off' : suggest}`, async ($, on) => {
    const calls = engine(on, { config: { suggest } })
    await $.session.start(START)
    await turns($, 6, 'please walk through the whole authentication module and explain every edge case in detail')
    expect(dialogs(calls)).toBe(0)
  })
}

test('one suggestion at a time, the most urgent first, and the next only at the next moment', async ($, on) => {
  const calls = engine(on, { config: { autoCompact: false, suggest: true } })
  await $.session.start(START)
  await turns($, 5, 'please walk through the whole authentication module and explain every edge case in detail')

  // A suggestion about prompt suggestions is on screen. Heavy now: the heavier matter waits behind it.
  expect(dialogs(calls)).toBe(1)
  await $.session.measure(state(85))
  expect(dialogs(calls)).toBe(1)
  await answer($ as never, 'later')

  await $.session.measure(state(95))
  expect(dialogs(calls)).toBe(2)
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: '会話がいっぱいに近づいています' })).toBeDefined()
})

// ── The note before a compaction is on by default, and the conversation that goes on is told where it is ──

const NOTE = '/t/claude-tokenomics/s/handoff-1.md'
const sessionStart = ($: Driver, source: string) => $.classic.SessionStart({ source } as never)
const signals = async ($: Driver, calls: Calls, key: string): Promise<number> => {
  await $.session.end({ reason: 'exit', sessionId: 's' } as never)
  return parseLedger(calls.store.get('ledger:v1')).days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)
}

test('with no offer accepted, a compaction is still preceded by a note, and the conversation that goes on is told once where it is', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  await $.session.start(START)

  await $.session.compact(compactInput({ instructions: 'focus on the plan' }))
  expect(calls.writes.map(w => w.path)).toEqual([NOTE])
  expect(calls.compactions.at(-1)?.instructions).toContain(`Details: ${NOTE}`)
  // Git is asked within the time the hook has, so a slow repository cannot make the compaction's own hook overrun.
  expect(calls.processTimeouts).toEqual([2_000])

  const started = await sessionStart($, 'compact')
  expect(started.additionalContext).toHaveLength(1)
  expect(started.additionalContext![0]).toContain(NOTE)
  expect(started.additionalContext![0]).toContain('The summary is the main record')
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
  for (const source of ['startup', 'resume', 'fork']) expect((await sessionStart($, source)).additionalContext ?? []).toEqual([])
  expect(await signals($, calls, 'S:signal:observe:compact_note_written')).toBe(1)
  expect(await signals($, calls, 'S:signal:observe:compact_pointer_given')).toBe(1)
})

test('a compaction that installed nothing, a precomputed summary and a subagent’s compaction leave no line for the next start', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript, compacted: { skip: 'nothing to compact' } })
  await $.session.start(START)

  await $.session.compact(compactInput())
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
  await $.session.compact(compactInput({ trigger: 'precompute' }))
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
  await $.session.compact(compactInput({ agentId: 'sub-1' }))
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
  expect(calls.writes.map(w => w.path)).toEqual([NOTE, '/t/claude-tokenomics/s/handoff-pre.md'])
})

test('set to off, no note is written before a compaction until an offer to compact is accepted', { options: { handoffNote: false } }, async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  await $.session.start(START)

  await $.session.compact(compactInput())
  expect(calls.writes).toEqual([])
  expect(calls.compactions.at(-1)?.instructions).toBeUndefined()
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
  expect(await signals($, calls, 'S:signal:observe:compact_start_without_note')).toBe(0)

  // The offer still does what it did: it asks for the note, now and from then on.
  await $.session.measure(state(80))
  await answer($ as never, 'accept')
  expect(calls.writes.map(w => w.path)).toEqual([NOTE])
  expect((await sessionStart($, 'compact')).additionalContext?.[0]).toContain(NOTE)
})

test('a person held back from the savings gets no note and no line on their own', { options: { holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  await $.session.start(START)
  await $.session.compact(compactInput())
  expect(calls.writes).toEqual([])
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
})

test('a compaction start with no note where one was to be expected is counted, for the person who looks', async ($, on) => {
  const calls = engine(on, { messages: transcript })
  await $.session.start(START)
  await $.session.compact(compactInput())
  expect((await sessionStart($, 'compact')).additionalContext ?? []).toEqual([])
  expect(await signals($, calls, 'S:signal:observe:compact_start_without_note')).toBe(1)
})

test('where the note is on by default, the offer does not speak of starting it', async ($, on) => {
  engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  await $.session.start(START)
  await $.session.measure(state(80))
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' })
  expect(await dialog.find({ type: 'Text', text: /メモに残してから要約します/ })).toBeDefined()
  expect(await dialog.find({ type: 'Text', text: /以降の要約でも/ })).toBeUndefined()
  await dialog.unmount()
})

