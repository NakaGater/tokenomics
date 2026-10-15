import { type Engine, describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/lib/core/ledger'
import { initialFacts } from '../hooks/lib/facts'
import {
  FALLBACK_BUFFER,
  WINDOW_RECOMMENDED,
  WINDOW_STOPS,
  commandArg,
  commandOf,
  currentLine,
  pickLines,
  pickOf,
  rulerOf,
  savingAgainst,
  savingAt,
  startsAt,
  stepPick,
  windowView,
} from '../hooks/lib/window'
import type { Facts } from '../types'

import { type Calls, SURFACES, engine, measure, settingsPaneProps } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

/** A 1M model with the engine's own size (it compacts at 967k), or as `over` says. */
const facts = (over: Partial<Facts> = {}): Facts => ({
  ...initialFacts,
  contextTokens: 150_000,
  contextWindow: 1_000_000,
  contextPercent: 15,
  autoCompactThreshold: 967_000,
  autoCompactSource: 'auto',
  autoCompactWindow: 1_000_000,
  isAutoCompactEnabled: true,
  ...over,
})

/** The user's own: a window of 500k, which compacts at 467k. */
const own = facts({ autoCompactWindow: 500_000, autoCompactThreshold: 467_000, autoCompactSource: 'settings' })

const view = (f: Facts) => {
  const v = windowView(f)
  if (v === null) throw new Error('no view')
  return v
}

describe('the table of sizes', () => {
  test('runs from 100k to 1M in the order of the slider, and 300k is the recommended stop', () => {
    expect(WINDOW_STOPS[0]?.tokens).toBe(100_000)
    expect(WINDOW_STOPS[WINDOW_STOPS.length - 1]?.tokens).toBe(1_000_000)
    expect(WINDOW_STOPS.map(s => s.tokens)).toEqual([...WINDOW_STOPS.map(s => s.tokens)].sort((a, b) => a - b))
    expect(WINDOW_STOPS.some(s => s.tokens === WINDOW_RECOMMENDED)).toBe(true)
    // The standard saves nothing against itself.
    expect(WINDOW_STOPS[WINDOW_STOPS.length - 1]?.saving).toBe(0)
  })

  test('300k saves most of what the best size does with far fewer compactions, and 100k saves less than 150k', () => {
    const at = (n: number) => WINDOW_STOPS.find(s => s.tokens === n)!
    const best = Math.max(...WINDOW_STOPS.map(s => s.saving))
    expect(best - at(300_000).saving).toBeLessThanOrEqual(5)
    expect(at(300_000).times).toBeLessThan(at(200_000).times)
    expect(at(100_000).saving).toBeLessThan(at(150_000).saving)
    expect(at(100_000).times).toBeGreaterThan(at(150_000).times)
  })

  test('between two stops the saving runs in a straight line; beyond the ends it stays', () => {
    expect(savingAt(300_000)).toBe(45)
    expect(savingAt(450_000)).toBe(37.5)
    expect(savingAt(50_000)).toBe(25)
    expect(savingAt(2_000_000)).toBe(0)
  })

  test('a saving against another size is the cost ratio, to the nearest 5, and negative where it spends more', () => {
    expect(savingAgainst(300_000, 1_000_000)).toBe(45)
    // (1 - .45) / (1 - .35) = .846: 15% less than 500k.
    expect(savingAgainst(300_000, 500_000)).toBe(15)
    expect(savingAgainst(500_000, 300_000)).toBe(-20)
    expect(savingAgainst(300_000, 300_000)).toBe(0)
  })
})

describe('what the pane works from', () => {
  test('no choice is offered where the model’s window is already short, or not yet known', () => {
    expect(windowView(facts({ contextWindow: 200_000, autoCompactWindow: 200_000, autoCompactThreshold: 167_000 }))).toBeNull()
    expect(windowView(facts({ contextWindow: null }))).toBeNull()
  })

  test('the stops are those the model’s window allows, and the window in force is read off the breakdown', () => {
    expect(view(facts()).stops.length).toBe(WINDOW_STOPS.length)
    expect(view(facts({ contextWindow: 500_000, autoCompactWindow: 500_000 })).stops.at(-1)?.tokens).toBe(500_000)
    const v = view(own)
    expect(v.current).toBe(500_000)
    expect(v.standard).toBe(1_000_000)
    expect(v.buffer).toBe(33_000)
    expect(startsAt(v, 300_000)).toBe(267_000)
  })

  test('where the breakdown has not said, the window in force is the model’s and the buffer is the usual 33k', () => {
    const v = view(facts({ autoCompactWindow: null, autoCompactThreshold: null }))
    expect(v.current).toBe(1_000_000)
    expect(v.buffer).toBe(FALLBACK_BUFFER)
  })

  test('a size someone else chose is marked, and so is auto-compaction being off', () => {
    expect(view(facts({ autoCompactSource: 'env' })).isOwned).toBe(true)
    expect(view(facts({ autoCompactSource: 'clientdata' })).isOwned).toBe(true)
    expect(view(facts({ autoCompactSource: 'settings' })).isOwned).toBe(false)
    expect(view(facts({ isAutoCompactEnabled: false })).isOff).toBe(true)
  })

  test('the slider starts on 300k whatever is in force, and steps along the stops without leaving them', () => {
    const v = view(own)
    expect(pickOf(v, null)).toBe(300_000)
    expect(pickOf(v, 400_000)).toBe(400_000)
    // An asked size the model does not allow is not taken.
    expect(pickOf(view(facts({ contextWindow: 500_000 })), 900_000)).toBe(300_000)
    expect(stepPick(v, 300_000, -1)).toBe(250_000)
    expect(stepPick(v, 300_000, 1)).toBe(350_000)
    expect(stepPick(v, 100_000, -1)).toBe(100_000)
    expect(stepPick(v, 1_000_000, 1)).toBe(1_000_000)
  })

  test('the command: the model’s own window is "auto"; any other size is in thousands', () => {
    const v = view(own)
    expect(commandArg(v, 300_000)).toBe('300k')
    expect(commandOf(v, 150_000)).toBe('/autocompact 150k')
    expect(commandArg(v, 1_000_000)).toBe('auto')
  })
})

describe('what is said', () => {
  test('the size in force, and what it saves against the standard', () => {
    expect(currentLine(view(own), true)).toBe('いま: 500k。約 467k tok で要約が始まり、標準より 費用が約 35% 少ない目安。')
    expect(currentLine(view(facts()), true)).toBe('いま: 1M（標準）。約 967k tok まで育ってから要約されます。')
    expect(currentLine(view(facts({ isAutoCompactEnabled: false })), true)).toContain('オフ')
  })

  test('the recommended size says why, and what it saves over the size in force', () => {
    const lines = pickLines(view(own), 300_000)
    expect(lines.isRecommended).toBe(true)
    expect(lines.againstStandard).toBe('標準の 1M より 約 45% 少ない')
    expect(lines.againstNow).toBe('今の 500k より 約 15% 少ない')
    expect(lines.starts).toBe('約 267k tok から')
    expect(lines.times).toContain('約 6 回')
    expect(lines.reason).toContain('200k の約半分')
    expect(lines.command).toBe('/autocompact 300k')
  })

  test('another size does not claim the recommendation, and one that spends more than now says so', () => {
    const lines = pickLines(view(facts({ autoCompactWindow: 300_000, autoCompactThreshold: 267_000, autoCompactSource: 'settings' })), 600_000)
    expect(lines.isRecommended).toBe(false)
    expect(lines.reason).toBe('')
    expect(lines.againstNow).toBe('今の 300k より 約 45% 多い')
    expect(lines.againstStandard).toBe('標準の 1M より 約 20% 少ない')
  })

  test('the size in force is marked as such, and on a subscription the word is use, not cost', () => {
    const lines = pickLines(view(own), 500_000)
    expect(lines.isCurrent).toBe(true)
    expect(lines.againstNow).toBe('今の設定です')
    expect(currentLine(view(own), false)).toContain('使用量が約 35% 少ない目安')
    expect(currentLine(view(own), false)).not.toContain('費用')
  })

  test('the ruler names the sizes each at its stop, in plain characters', () => {
    const ruler = rulerOf(view(facts()), 3)
    expect(ruler.startsWith('100k')).toBe(true)
    expect(ruler.indexOf('300k')).toBe(4 * 3)
    expect(ruler.indexOf('500k')).toBe(7 * 3)
    // The 1M is flush with the last stop: 13 stops, the track 37 cells across.
    expect(ruler.length).toBe(37)
    expect(ruler.endsWith('1M')).toBe(true)
  })
})

/** The pane of a session whose window is 1M, with the user's 500k in force, as the breakdown reports it. */
const engineOn = (on: Parameters<typeof engine>[0], over: Parameters<typeof engine>[1] = {}) =>
  engine(on, { autoCompactWindow: { threshold: 467_000, source: 'settings', window: 500_000 }, ...over })

const start = async ($: Engine) => {
  await $.session.start(START)
  await $.session.measure(measure.context(15, 1_000_000))
  // The breakdown is read with the first turn's figures; ask for it as the pane's 調べる does.
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 150_000, model: 'claude-opus-5-5' } } as never)
}

/** The session ends, which writes the ledger out; how many times the ledger counted `key`, and every key of the ledger. */
const counted = async ($: Engine, calls: Calls) => {
  await $.session.end({ reason: 'exit' } as never)
  const days = parseLedger(calls.store.get('ledger:v1')).days
  const all: Record<string, number> = {}
  for (const d of days) for (const [k, v] of Object.entries(d.counts)) all[k] = (all[k] ?? 0) + v
  return all
}

const windowKeys = (all: Record<string, number>): string[] => Object.keys(all).filter(k => k.includes('window_')).sort()

describe('the pane’s slider', () => {
  test('is drawn on both surfaces, with 300k chosen and called the recommendation, and the size in force beside it', async ($, on) => {
    engineOn(on)
    await start($)
    for (const surface of SURFACES) {
      const pane = await $.ui.mount({ ...settingsPaneProps, surface })
      expect(await pane.find({ type: 'Text', text: '自動要約のタイミング' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'いま: 500k。約 467k tok で要約が始まり、標準より 費用が約 35% 少ない目安。' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '★ おすすめ' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'window-apply' })).toBeDefined()
      expect(await pane.find({ type: 'Button', text: '300k にする（おすすめ）' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'window-reset' })).toBeDefined()
      await pane.unmount()
    }
  })

  test('the terminal draws the track as a button for each stop, and stepping or pressing a stop moves the thumb', async ($, on) => {
    engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    for (const tokens of WINDOW_STOPS.map(s => s.tokens)) {
      expect(await pane.find({ type: 'Button', key: `window-stop-${tokens}` })).toBeDefined()
    }

    await pane.press({ key: 'window-more' })
    expect(await pane.find({ type: 'Button', text: '350k にする' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '★ おすすめ' })).toBeUndefined()

    await pane.press({ key: 'window-stop-200000' })
    expect(await pane.find({ type: 'Button', text: '200k にする' })).toBeDefined()

    // Back on the size in force, there is nothing to apply.
    await pane.press({ key: 'window-stop-500000' })
    expect(await pane.find({ type: 'Text', text: 'いまの設定' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'window-apply' })).toBeUndefined()
    await pane.unmount()
  })

  test('pressing the button runs /autocompact, checks that the size the engine reports is the one asked for, and says so', async ($, on) => {
    const calls = engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-apply' })

    expect(calls.commands).toEqual([{ command: 'autocompact', args: '300k' }])
    expect(calls.filled).toEqual([])
    expect(calls.toasts.at(-1)).toContain('自動要約のタイミングを 300k にしました（約267k tok で要約が始まります')
    // The pane now reads the new size: the apply button is gone and the thumb is on the size in force.
    expect(await pane.find({ type: 'Text', text: 'いまの設定' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'window-apply' })).toBeUndefined()
    await pane.unmount()
  })

  test('a size other than the recommended one, once set, stays chosen: the recommendation is not offered straight after', async ($, on) => {
    const calls = engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-stop-200000' })
    await pane.press({ key: 'window-apply' })

    expect(calls.commands).toEqual([{ command: 'autocompact', args: '200k' }])
    expect(calls.toasts.at(-1)).toContain('自動要約のタイミングを 200k にしました（約167k tok で要約が始まります')
    expect(await pane.find({ type: 'Text', text: 'いまの設定' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'window-apply' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', text: '300k にする' })).toBeUndefined()
    await pane.unmount()
  })

  test('a size moved to but not applied is forgotten when the settings pane is opened again: the slider starts on the recommended size', async ($, on) => {
    engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-stop-200000' })
    expect(await pane.find({ type: 'Button', text: '200k にする' })).toBeDefined()
    await pane.unmount()

    await $.command.run({ command: 'tokenomics', args: 'settings', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    const again = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    expect(await again.find({ type: 'Button', text: '300k にする（おすすめ）' })).toBeDefined()
    await again.unmount()
  })

  test('"標準に戻す" runs /autocompact auto', async ($, on) => {
    const calls = engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-reset' })

    expect(calls.commands).toEqual([{ command: 'autocompact', args: 'auto' }])
    expect(calls.toasts.at(-1)).toContain('標準に戻しました')
    await pane.unmount()
  })

  test('a build that keeps the command to the person gets it typed for them to confirm', async ($, on) => {
    const calls = engineOn(on, { autocompactCommand: 'rejects' })
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-apply' })

    expect(calls.filled).toEqual(['/autocompact 300k'])
    expect(calls.toasts.at(-1)).toContain('Enter で /autocompact 300k を実行します')
    await pane.unmount()
  })

  test('a run that changes nothing is not reported as done: the command is typed instead', async ($, on) => {
    const calls = engineOn(on, { autocompactCommand: 'ignored' })
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-apply' })

    expect(calls.commands.length).toBe(1)
    expect(calls.toasts.some(t => t.includes('にしました'))).toBe(false)
    expect(calls.filled).toEqual(['/autocompact 300k'])
    await pane.unmount()
  })

  test('is not drawn where the model’s window is short', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.session.measure(measure.context(15, 200_000))
    const short = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    expect(await short.find({ type: 'Text', text: '自動要約のタイミング' })).toBeUndefined()
    await short.unmount()
  })

  test('with auto-compaction off the section says so and has no button to set a size', async ($, on) => {
    engine(on, { config: { autoCompact: false } })
    await $.session.start(START)
    await $.session.measure(measure.context(15, 1_000_000))
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 150_000, model: 'claude-opus-5-5' } } as never)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: '自動要約のタイミング' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'window-apply' })).toBeUndefined()
    await pane.unmount()
  })

  test('the ledger counts which size was set from the pane, as a count with the size in its name and nothing else', async ($, on) => {
    const calls = engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-apply' })
    await pane.press({ key: 'window-stop-200000' })
    await pane.press({ key: 'window-apply' })
    await pane.press({ key: 'window-reset' })
    await pane.unmount()

    const all = await counted($, calls)
    expect(windowKeys(all)).toEqual(['S:signal:observe:window_pane_200k', 'S:signal:observe:window_pane_300k', 'S:signal:observe:window_pane_auto'])
    for (const k of windowKeys(all)) expect(all[k]).toBe(1)
    // Only counts: nothing of the person's is in it.
    expect(JSON.stringify(calls.store.get('ledger:v1'))).not.toContain('/autocompact')
  })

  test('stepping the thumb sets nothing and so records nothing', async ($, on) => {
    const calls = engineOn(on)
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-more' })
    await pane.press({ key: 'window-stop-150000' })
    await pane.unmount()

    expect(windowKeys(await counted($, calls))).toEqual([])
  })

  test('a command typed for the person is counted as typed, not as a size set', async ($, on) => {
    const calls = engineOn(on, { autocompactCommand: 'rejects' })
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-apply' })
    await pane.unmount()

    expect(windowKeys(await counted($, calls))).toEqual(['S:signal:observe:window_typed_pane'])
  })

  test('a run that changes nothing is counted as typed too', async ($, on) => {
    const calls = engineOn(on, { autocompactCommand: 'ignored' })
    await start($)
    const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
    await pane.press({ key: 'window-apply' })
    await pane.unmount()

    expect(windowKeys(await counted($, calls))).toEqual(['S:signal:observe:window_typed_pane'])
  })
})
