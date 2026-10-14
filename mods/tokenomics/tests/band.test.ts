import { expect, test } from 'claude-code/testing'

import { DEMO_SHORT } from '../hooks/lib/core/nudges'
import { cardExtraRows } from '../hooks/ui/band'
import { FACE } from '../hooks/lib/mascot'

import { SURFACES, bandProps, engine, frameColor, measure, nudgeIn, phraseIn, runStep, savedValueIn } from './kit'

const USAGE = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 2000, cache_read_input_tokens: 2_100_000, model: 'm' }

const finishTurn = ($: { turn: { complete: (e: never) => Promise<unknown> } }, usage = USAGE) =>
  $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)

test('a fresh session shows the context at 0% and an empty "this turn", and nothing to do', async ($, on) => {
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...bandProps(), surface })
    expect(await ui.find({ type: 'Text', text: /0%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'analysis' })).toBeDefined()
    expect(await ui.find({ key: 'offer-accept' })).toBeUndefined()
    expect(await ui.find({ key: 'later' })).toBeUndefined()

    // The terminal draws a cat and a gauge; the desktop, which has no grid of cells, draws the plain bar.
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeDefined()
      expect(await ui.find({ type: 'Raster', key: 'gauge' })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /0%/ }))?.text).toContain('░░░░░░░░░░')
    }
    await ui.unmount()
  }
})

test('after a turn the band shows the fill and the turn as the API counted it: the prompt with the cache’s share, and the output', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(52))
  await finishTurn($ as never)

  // 104k of the 160k the engine compacts at.
  expect(await ui.find({ type: 'Text', text: /65%/ })).toBeDefined()
  // 900 uncached + 2,000 written + 2,100,000 read; the output on its own. Every kind is named and has its unit.
  for (const text of ['入力 2.1M tok', '2.1M tok', '2k tok', '900 tok', '300 tok']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  for (const label of ['現在のターンの合計', '出力', '└ キャッシュ読み', 'キャッシュ書き込み', 'キャッシュなし']) {
    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
  }
  // The old sum (fresh input + writes + output) and the short names are no longer shown.
  expect(await ui.find({ type: 'Text', text: '3.2k tok' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /読 |書 / })).toBeUndefined()
})

test('the band says how many requests the turn made, and that its figures are the turn’s total', async ($, on) => {
  const options = { stepUsage: { input_tokens: 2, output_tokens: 700, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 1_000, model: 'm' } }
  engine(on, options)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  // Two requests, the second sending the conversation the first left.
  await runStep($ as never, { agentId: undefined })
  options.stepUsage = { input_tokens: 2, output_tokens: 500, cache_read_input_tokens: 151_000, cache_creation_input_tokens: 2_000, model: 'm' }
  await runStep($ as never, { agentId: undefined })
  await finishTurn($ as never, { input_tokens: 4, output_tokens: 1_200, cache_read_input_tokens: 301_000, cache_creation_input_tokens: 3_000, model: 'm' })

  expect(await ui.find({ type: 'Text', text: '現在のターンの合計' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'リクエスト' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 回' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '入力 304k tok' })).toBeDefined()

  // The next turn starts the turn's count over; the session's goes on: three requests in two turns, then the turn's one.
  options.stepUsage = { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 153_000, cache_creation_input_tokens: 100, model: 'm' }
  await runStep($ as never, { agentId: undefined })
  await finishTurn($ as never, { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 153_000, cache_creation_input_tokens: 100, model: 'm' })
  const counts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').filter(t => /^\d+ 回$/.test(t))
  expect(counts).toEqual(['3 回', '2 回', '1 回'])
})

test('the session’s row stands under the context and over the turn’s, and counts the turn under way', async ($, on) => {
  const first = { input_tokens: 2, output_tokens: 700, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 1_000, model: 'm' }
  const options = { stepUsage: first }
  engine(on, options)
  // Wide enough that the first chip is named in full.
  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 150 }), surface: 'terminal' })
  const texts = async (): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')

  // Before a turn: a dash for the session as for the turn, and the saving is there all the same, none yet.
  expect((await texts()).filter(t => t === '—')).toHaveLength(2)
  expect(await savedValueIn(ui)).toBe('0 tok')

  // One request of the first turn is in: the turn is part of the session while it runs, so the two say the same.
  await runStep($ as never, { agentId: undefined })
  let t = await texts()
  expect(t.indexOf('コンテキスト')).toBeLessThan(t.indexOf('現在のセッションの合計'))
  expect(t.indexOf('現在のセッションの合計')).toBeLessThan(t.indexOf('現在のターンの合計'))
  expect(t.filter(x => x === '入力 151k tok')).toHaveLength(2)

  // The turn ends: nothing is counted twice. The row is the prompt whole, the output, the requests and the turns.
  options.stepUsage = { input_tokens: 2, output_tokens: 500, cache_read_input_tokens: 151_000, cache_creation_input_tokens: 2_000, model: 'm' }
  await runStep($ as never, { agentId: undefined })
  await finishTurn($ as never, { input_tokens: 4, output_tokens: 1_200, cache_read_input_tokens: 301_000, cache_creation_input_tokens: 3_000, model: 'm' })
  t = await texts()
  expect(t.slice(t.indexOf('現在のセッションの合計'), t.indexOf('現在のターンの合計'))).toEqual([
    '現在のセッションの合計', '入力 304k tok', '出力', '1.2k tok', 'リクエスト', '2 回', 'ターン', '1 回', '節約（延べ）', '0 tok',
  ])

  // A second turn under way: the session goes on from the first, the turn's own figures start over.
  options.stepUsage = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 153_000, cache_creation_input_tokens: 100, model: 'm' }
  await runStep($ as never, { agentId: undefined })
  t = await texts()
  expect(t.slice(t.indexOf('現在のセッションの合計'), t.indexOf('現在のターンの合計'))).toEqual([
    '現在のセッションの合計', '入力 457k tok', '出力', '1.3k tok', 'リクエスト', '3 回', 'ターン', '2 回', '節約（延べ）', '0 tok',
  ])
  expect(t).toContain('入力 153k tok')
})

test('where the band is one plain row, the session’s chips stand in it too', async ($, on) => {
  engine(on)
  await $.session.measure(measure.context(40))
  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 50 }), surface: 'terminal' })
  await finishTurn($ as never)

  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '現在のセッションの合計' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ターン' })).toBeDefined()
})

test('a subagent’s steps are not the main turn’s requests', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await runStep($ as never, { agentId: 'sub-1' })
  await runStep($ as never, { agentId: 'sub-1' })
  await runStep($ as never)
  await finishTurn($ as never)

  expect(await ui.find({ type: 'Text', text: '1 回' })).toBeDefined()
})

test('a heavy conversation only changes the band’s look: the suggestion is a dialog of its own', async ($, on) => {
  const calls = engine(on)
  const card = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  const plain = await $.ui.mount({ ...bandProps(), surface: 'desktop' })

  await $.session.measure(measure.context(78))

  expect(calls.opened).toEqual(['tokenomics-offer'])
  expect(await frameColor(card)).toBe('warning')
  expect(await plain.find({ type: 'Text', text: FACE.heavy })).toBeDefined()
  for (const ui of [card, plain]) {
    expect(await ui.find({ type: 'Text', text: '会話が重くなってきました' })).toBeUndefined()
    expect(await ui.find({ key: 'offer-accept' })).toBeUndefined()
  }
})

test('advice with nothing to press is one row beneath, can be put off, and stays off until it begins again', async ($, on) => {
  engine(on)
  const limited = (percentUsed: number) => ({
    ...measure.context(20),
    rateLimits: [{ kind: 'five_hour', percentUsed }],
    changed: ['rateLimits' as const],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...bandProps(), surface })

    await $.session.measure(limited(85))
    expect(await ui.find({ type: 'Text', text: '5時間の上限の85%を使いました' })).toBeDefined()
    await ui.press({ key: 'later' })
    expect(await ui.find({ type: 'Text', text: '5時間の上限の85%を使いました' })).toBeUndefined()

    // Still high: still put off.
    await $.session.measure(limited(88))
    expect(await ui.find({ type: 'Text', text: /上限の88%/ })).toBeUndefined()

    // Reset, then high again: a new thing to say.
    await $.session.measure(limited(10))
    await $.session.measure(limited(86))
    expect(await ui.find({ type: 'Text', text: /上限の86%/ })).toBeDefined()

    await $.session.measure(limited(10))
  }
})

test('a survey holds the band: the mod yields', async ($, on) => {
  engine(on)
  await $.session.measure(measure.context(92))

  const ui = await $.ui.mount({ ...bandProps({ hasSurvey: true }), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /コンテキスト/ })).toBeUndefined()
})

test('where no pane fits, the suggestion stands as a card above the band, and the waiting pane is taken down', async ($, on) => {
  const calls = engine(on, { isPlaced: false })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...bandProps(), surface })
    await $.session.measure(measure.context(78))

    expect(calls.closed).toContain('tokenomics-offer')
    expect(await ui.find({ type: 'Text', text: '会話が重くなってきました' })).toBeDefined()
    expect(await ui.find({ key: 'offer-accept' }).then(b => b?.props.label)).toBe('要約する')
    expect(await ui.find({ key: 'offer-later' }).then(b => b?.props.label)).toBe('あとで')
    expect(await ui.find({ key: 'offer-mute' }).then(b => b?.props.label)).toBe('もう出さない')
    // The card is a framed box, so it reads as a pop-up.
    expect((await ui.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(true)

    await ui.press({ key: 'offer-later' })
    expect(await ui.find({ key: 'offer-accept' })).toBeUndefined()
    await $.session.measure(measure.context(10))
  }
})

test('the card waits while a turn runs, and comes back when it ends', async ($, on) => {
  engine(on, { isPlaced: false })
  await $.session.measure(measure.context(92))

  const working = await $.ui.mount({ ...bandProps({ isWorking: true }), surface: 'desktop' })
  expect(await working.find({ key: 'offer-accept' })).toBeUndefined()
  expect(await working.find({ type: 'Text', text: FACE.full })).toBeDefined()

  const idle = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  expect(await idle.find({ type: 'Text', text: '会話がいっぱいに近づいています' })).toBeDefined()
  expect(await frameColor(idle)).toBe('error')
})

test('where the cat’s card and a suggestion above it would not fit, the plain row goes under the suggestion, so its buttons stay in view', async ($, on) => {
  engine(on, { isPlaced: false })
  await $.session.measure(measure.context(92))

  // Room for the card and a suggestion: both.
  const roomy = await $.ui.mount({ ...bandProps({ maxRows: 24 }), surface: 'terminal' })
  expect(await roomy.find({ type: 'Raster', key: 'cat' })).toBeDefined()
  expect(await roomy.find({ key: 'offer-accept' })).toBeDefined()
  await roomy.unmount()

  // Room for the suggestion and a plain row only.
  const cramped = await $.ui.mount({ ...bandProps({ maxRows: 12 }), surface: 'terminal' })
  expect(await cramped.find({ type: 'Raster' })).toBeUndefined()
  expect(await cramped.find({ key: 'offer-accept' })).toBeDefined()
  expect(await cramped.find({ type: 'Text', text: FACE.full })).toBeDefined()
  await cramped.unmount()
})

test('Clawd’s card needs its seven rows: with less room the band is the plain row, suggestion or none', async ($, on) => {
  engine(on)
  const seven = await $.ui.mount({ ...bandProps({ maxRows: 7 }), surface: 'terminal' })
  expect(await seven.find({ type: 'Raster', key: 'cat' })).toBeDefined()
  await seven.unmount()

  const six = await $.ui.mount({ ...bandProps({ maxRows: 6 }), surface: 'terminal' })
  expect(await six.find({ type: 'Raster' })).toBeUndefined()
  expect(await six.find({ type: 'Button', key: 'analysis' })).toBeDefined()
})

test('accepting from the card compacts once, says how much it saved, and lowers the fill at once', async ($, on) => {
  const calls = engine(on, { isPlaced: false, compacted: { tokensBefore: 160_000, tokensAfter: 40_000 } })
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(80))
  await ui.press({ key: 'offer-accept' })

  expect(calls.compacts).toBe(1)
  expect(calls.toasts).toEqual([`${FACE.good} 要約して軽くしました（160k → 40k tok）`])
  expect(await ui.find({ type: 'Text', text: /20%/ })).toBeDefined()
  expect(await ui.find({ key: 'offer-accept' })).toBeUndefined()
})

test('a compaction that is refused leaves the band as it was, says so, and does not ask again', async ($, on) => {
  const calls = engine(on, { isPlaced: false, compacted: { skip: 'hook said no' } })
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure(measure.context(80))
  await ui.press({ key: 'offer-accept' })

  expect(calls.toasts).toEqual([`${FACE.heavy} いまは要約できませんでした。`])
  expect(await ui.find({ type: 'Text', text: /80%/ })).toBeDefined()
  // Once in this spell, as promised.
  await $.session.measure(measure.context(82))
  expect(await ui.find({ key: 'offer-accept' })).toBeUndefined()
})

// ── The one-line suggestion in the card ─────────────────────────────────────────────────────────────────

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

/** `/tokenomics nudge-test`, then a reply: the test line is put in the band, wherever the setting stands. */
const showNudge = async ($: { command: { run: (e: never) => Promise<unknown> }; turn: { complete: (e: never) => Promise<unknown> } }) => {
  await $.command.run({ command: 'tokenomics', args: 'nudge-test', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  await finishTurn($)
}

test('a one-line suggestion takes the place of the cat’s phrase in the card, and the cat, gauge and buttons stay', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  expect(await phraseIn(ui)).toBeDefined()
  expect(await nudgeIn(ui)).toBeUndefined()

  await showNudge($ as never)

  expect(await nudgeIn(ui)).toBe(DEMO_SHORT)
  expect(await phraseIn(ui)).toBeUndefined()
  expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'gauge' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'analysis' })).toBeDefined()
})

test('where the band is one plain row, the suggestion is a row of its own under it', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const desktop = await $.ui.mount({ ...bandProps(), surface: 'desktop' })
  const narrow = await $.ui.mount({ ...bandProps({ bodyColumns: 50 }), surface: 'terminal' })

  await showNudge($ as never)

  for (const ui of [desktop, narrow]) {
    expect(await nudgeIn(ui)).toBe(DEMO_SHORT)
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'analysis' })).toBeDefined()
  }
})

test('advice keeps its row beside the suggestion, and the phrase has neither of them to give way to', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure({ ...measure.context(20), rateLimits: [{ kind: 'five_hour', percentUsed: 82 }], changed: ['rateLimits'] })
  expect(await phraseIn(ui)).toBeUndefined()

  await showNudge($ as never)

  expect(await nudgeIn(ui)).toBe(DEMO_SHORT)
  expect(await ui.find({ type: 'Text', text: '5時間の上限の82%を使いました' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'later' })).toBeDefined()
  expect(await phraseIn(ui)).toBeUndefined()
})

test('a suggestion’s card is asked about first: the one-line suggestion is hidden under it and is back once it is closed', async ($, on) => {
  engine(on, { isPlaced: false })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measure.context(92))
  expect(await ui.find({ key: 'offer-accept' })).toBeDefined()

  await showNudge($ as never)
  expect(await nudgeIn(ui)).toBeUndefined()
  expect(await ui.find({ key: 'offer-accept' })).toBeDefined()

  await ui.press({ key: 'offer-later' })
  expect(await ui.find({ key: 'offer-accept' })).toBeUndefined()
  expect(await nudgeIn(ui)).toBe(DEMO_SHORT)
})

test('a suggestion that wraps makes the card taller; where the room is short of that, the band is the plain row, and the suggestion is still there', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await showNudge($ as never)

  // DEMO_SHORT is 78 cells: three rows in the 34 the card leaves at 56 columns, two at 100, one at 120. The card is seven rows with one.
  // The last turn's chips (the usage of finishTurn) take two rows where they fit side by side, as at 100 and 120 columns, and the session's chips one.
  // The card's right column is the gauge, the session's chips, the turn's chips, the suggestion and the buttons, so one row of the session, two of the turn and a one-line suggestion fill Clawd's five and one row more.
  // In the 34 cells at 56 columns the first row of the turn's two chips are 32 and 12 cells (the label saying what the figures total is long) and stand one to a row;
  // with the label as "今回" alone they are 17 and 12 and stand side by side, and the cache's three (25, 25 and 22) stand one to a row: four rows of chips.
  // The session's first chip is 36 cells with its long label, wider than the 34, so it is "セッション" alone (24): its chips stand three rows (24; 12 and 11; the saving's 18).
  // At 100 columns the long label would wrap the row (83 cells in 78) and the short one would not (71), so it is "セッション" there too.
  const places = [
    { bodyColumns: 56, rows: 14 },
    { bodyColumns: 100, rows: 9 },
    { bodyColumns: 120, rows: 8 },
  ]
  for (const place of places) {
    const fits = await $.ui.mount({ ...bandProps({ bodyColumns: place.bodyColumns, maxRows: place.rows }), surface: 'terminal' })
    expect(await fits.find({ type: 'Raster', key: 'cat' })).toBeDefined()
    expect(await nudgeIn(fits)).toBe(DEMO_SHORT)
    await fits.unmount()

    const short = await $.ui.mount({ ...bandProps({ bodyColumns: place.bodyColumns, maxRows: place.rows - 1 }), surface: 'terminal' })
    expect(await short.find({ type: 'Raster' })).toBeUndefined()
    expect(await nudgeIn(short)).toBe(DEMO_SHORT)
    await short.unmount()
  }
})

// ── The card's rows ──

const TURN = { input: 4, output: 107, cacheRead: 73_000, cacheWrite: 21_000, steps: [{ input: 4, output: 107, cacheRead: 73_000, cacheWrite: 21_000 }] } as never

test('the cat’s phrase stands beside the buttons and takes no row of its own; a suggestion or advice does take one', () => {
  // Before a turn the right column is the gauge's row, a dash for the session, a dash for the turn and the buttons' row: four rows, and Clawd's five hold the card.
  expect(cardExtraRows(null, false, 100, null)).toBe(0)
  // With a turn counted, its chips stand two rows and the session's one: the right column is as tall as Clawd, five rows.
  expect(cardExtraRows(null, false, 100, TURN)).toBe(0)
  // Advice, or a one-line suggestion, is a row of its own beneath the chips: the card is a row taller than Clawd.
  expect(cardExtraRows(null, true, 100, TURN)).toBe(1)
  expect(cardExtraRows(DEMO_SHORT, false, 120, TURN)).toBe(1)
  // Advice under a suggestion is one more; a suggestion that wraps in the right column, as many more as it wraps.
  expect(cardExtraRows(DEMO_SHORT, true, 120, TURN)).toBe(2)
  expect(cardExtraRows(DEMO_SHORT, false, 100, TURN)).toBe(2)
  // The session's chips that wrap into more rows are asked for.
  expect(cardExtraRows(null, false, 100, TURN, 2)).toBe(1)
})

test('the card’s wrapping boxes put no blank rows between the rows they wrap into: they have a gap between columns and none between rows', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 100 }), surface: 'terminal' })
  await $.session.measure(measure.context(40))
  await finishTurn($ as never)
  const wrapping = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexWrap === 'wrap')
  // The gauge's row, the two rows of the last turn's chips and the buttons' row.
  expect(wrapping.length).toBeGreaterThanOrEqual(4)
  for (const box of wrapping) {
    expect(box.props.gap, 'a gap would also separate the rows').toBeUndefined()
    expect(box.props.columnGap).toBeGreaterThan(0)
  }
})

test('the card’s gauge row can carry the figures beside the gauge, and the buttons row ends in the cat’s phrase', async ($, on) => {
  engine(on)
  await $.session.measure(measure.context(40))
  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 100 }), surface: 'terminal' })
  type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as Node[]
  const rows = boxes.filter(b => b.props.flexWrap === 'wrap')
  const keysIn = (n: Node | string): string[] => (typeof n !== 'object' || n === null ? [] : [String(n.props?.key ?? ''), ...(n.children ?? []).flatMap(keysIn)])

  // The gauge and what stands beside it are one wrapping row; the buttons and the phrase are another.
  const gaugeRow = rows.find(r => keysIn(r).includes('gauge'))
  expect(gaugeRow).toBeDefined()
  expect(keysIn(gaugeRow as Node)).not.toContain('analysis')
  const buttonsRow = rows.find(r => keysIn(r).includes('analysis'))
  expect(keysIn(buttonsRow as Node)).toContain('settings')
  const last = buttonsRow?.children?.at(-1) as Node
  expect(last.type).toBe('Text')
  expect(last.props.dimColor).toBe(true)
})

test('the first chip says "現在のターンの合計" at ease, and "今回" alone only where that saves the first row a wrap', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 100 }), surface: 'terminal' })
  await $.session.measure(measure.context(40))
  await finishTurn($ as never)
  // 78 cells for the chips: the label fits with the rest of the row.
  expect(await ui.find({ type: 'Text', text: '現在のターンの合計' })).toBeDefined()
  await ui.unmount()

  // The first row is 46 cells with the long label (32 and 12 and the gap) and 31 with the short one; 44 are left of a band 66 across.
  const narrow = await $.ui.mount({ ...bandProps({ bodyColumns: 66 }), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: '現在のターンの合計' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: '今回' })).toBeDefined()
  // Everything else is named in full and has its unit.
  for (const label of ['出力', '└ キャッシュ読み', 'キャッシュ書き込み', 'キャッシュなし']) {
    expect(await narrow.find({ type: 'Text', text: label })).toBeDefined()
  }
})

test('dollars appear on API billing once they matter; on a subscription the limits do instead', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.session.measure({ ...measure.context(20), cost: { usd: 0.4 } })
  expect(await ui.find({ type: 'Text', text: '累計' })).toBeUndefined()

  await $.session.measure({ ...measure.context(20), cost: { usd: 2.5 } })
  expect(await ui.find({ type: 'Text', text: '$2.50' })).toBeDefined()

  await $.session.measure({
    ...measure.context(20),
    cost: { usd: 2.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
    changed: ['rateLimits'],
  })
  expect(await ui.find({ type: 'Text', text: '$2.50' })).toBeUndefined()
  // 40% is not worth the room yet.
  expect(await ui.find({ type: 'Text', text: '5時間の上限' })).toBeUndefined()

  await $.session.measure({
    ...measure.context(20),
    rateLimits: [{ kind: 'five_hour', percentUsed: 82 }],
    changed: ['rateLimits'],
  })
  expect(await ui.find({ type: 'Text', text: '5時間の上限' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5時間の上限の82%を使いました' })).toBeDefined()
})

test('the card, with its 16-cell cat, needs 56 columns (what a docked pane leaves on 110); one column fewer and the band is a plain row', async ($, on) => {
  engine(on)
  const wide = await $.ui.mount({ ...bandProps({ bodyColumns: 56 }), surface: 'terminal' })
  const rasters = await wide.findAll({ type: 'Raster', key: 'cat' })
  expect(rasters.length).toBe(1)
  expect(rasters[0]?.props.columns).toBe(16)
  await wide.unmount()

  const narrow = await $.ui.mount({ ...bandProps({ bodyColumns: 55 }), surface: 'terminal' })
  expect((await narrow.findAll({ type: 'Raster', key: 'cat' })).length).toBe(0)
  expect(await narrow.find({ type: 'Text', text: FACE.good })).toBeDefined()
})

test('a narrow band keeps the fill and drops the rest to fit', async ($, on) => {
  engine(on)
  await $.session.measure(measure.context(52))

  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 40 }), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /52%/ }))?.text).toContain('▓▓▓░░░')
})

test('where the band is one plain row, the cat’s face follows how the conversation is doing', async ($, on) => {
  engine(on)
  // The desktop has no grid of cells, and a terminal under 66 columns has no room for the card.
  const places = [
    { surface: 'desktop' as const, bodyColumns: 100 },
    { surface: 'terminal' as const, bodyColumns: 50 },
  ]

  for (const place of places) {
    const ui = await $.ui.mount({ ...bandProps({ bodyColumns: place.bodyColumns }), surface: place.surface })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: FACE.good })).toBeDefined()

    await $.session.measure(measure.context(78))
    expect(await ui.find({ type: 'Text', text: FACE.heavy })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: FACE.good })).toBeUndefined()

    await $.session.measure(measure.context(95))
    expect(await ui.find({ type: 'Text', text: FACE.full })).toBeDefined()

    await $.session.measure(measure.context(20))
    expect(await ui.find({ type: 'Text', text: FACE.good })).toBeDefined()
  }
})

test('the face sits in a box as wide as the widest face, so the plain row does not shift', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...bandProps({ bodyColumns: 50 }), surface: 'terminal' })

  // The innermost box that holds the face is the last of those that do, in document order.
  const holder = async (face: string) => (await ui.findAll({ type: 'Box', text: face })).at(-1)

  expect((await holder(FACE.good))?.props.width).toBe(7)
  await $.session.measure(measure.context(95))
  expect((await holder(FACE.full))?.props.width).toBe(7)
})

test('the gauge counts toward the auto-compaction: the percent and the tokens against the size it runs at, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work' } as never)
  // 120k of the 160k the engine compacts at, in a window of 200k (60%).
  await $.session.measure(measure.context(60))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...bandProps(), surface })
    expect(await ui.find({ type: 'Text', text: /75%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '120k/160k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60%/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with no auto-compaction size to count toward, the gauge keeps the window’s share, and says its tokens against the window', async ($, on) => {
  engine(on, { autoCompactWindow: {} })
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measure.context(60))

  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '120k/200k' })).toBeDefined()
})

test('the gauge gives up length before the card gives up the cat: 6 cells at the narrowest card, the usual at ease', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measure.context(60))

  const lengths: [number, number][] = [[56, 6], [60, 10], [64, 14], [89, 14], [90, 20], [140, 20]]
  for (const [bodyColumns, gauge] of lengths) {
    const ui = await $.ui.mount({ ...bandProps({ bodyColumns }), surface: 'terminal' })
    expect((await ui.find({ type: 'Raster', key: 'gauge' }))?.props.columns, `at ${bodyColumns} columns`).toBe(gauge)
    await ui.unmount()
  }
})

test('the size the engine compacts at is read again as turns go by, so /autocompact shows without a restart', async ($, on) => {
  const options = { autoCompactWindow: { threshold: 160_000 } }
  const calls = engine(on, options)
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measure.context(50))
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  // The first turn reads the breakdown for what an empty session holds, whatever the time since the start.
  await finishTurn($ as never)
  expect(await ui.find({ type: 'Text', text: '100k/160k' })).toBeDefined()

  // The person sets a shorter window; a turn ending soon after still counts toward the old size, one after a minute does not.
  options.autoCompactWindow.threshold = 120_000
  await finishTurn($ as never)
  expect(await ui.find({ type: 'Text', text: '100k/160k' })).toBeDefined()
  await calls.clock.advance(61_000)
  await finishTurn($ as never)
  expect(await ui.find({ type: 'Text', text: '100k/120k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /83%/ })).toBeDefined()
})
