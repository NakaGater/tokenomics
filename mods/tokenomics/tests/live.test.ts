import { describe, expect, test } from 'claude-code/testing'

import type { RequestSize } from '../types'

import { applyPrompt, applyRequest, applyTurn, initialFacts, recentOf } from '../hooks/lib/facts'
import { turnTokens } from '../hooks/lib/format'

import { bandProps, engine, measure, paneProps, runStep } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const request = (cacheRead: number, over: Partial<RequestSize> = {}): RequestSize => ({
  input: 2,
  cacheWrite: 900,
  cacheRead,
  output: 300,
  isAdvisor: false,
  ...over,
})

const WITH_WINDOW = { ...initialFacts, contextWindow: 200_000, contextPercent: 10, contextTokens: 20_000 }

// The facts follow a turn as it goes: a request is in them when it is answered, not when the turn ends.

describe('a turn in progress, as the facts have it', () => {
  test('"this turn" is the sum of the requests so far, and the chart has them', () => {
    const f = applyRequest(WITH_WINDOW, [request(100_000), request(101_000)], 'm')
    expect(f.last).toEqual({
      spent: 4 + 1_800 + 600,
      input: 4,
      cacheWrite: 1_800,
      cacheRead: 201_000,
      output: 600,
      model: 'm',
      prompts: [100_902, 101_902],
    })
    expect(f.isLastRunning).toBe(true)
    expect(recentOf(f).map(r => [r.turn, r.cacheRead])).toEqual([
      [1, 100_000],
      [1, 101_000],
    ])
    // The session's totals wait for the turn to end, which adds all of it once.
    expect(f.turns).toBe(0)
    expect(f.session).toEqual(initialFacts.session)
  })

  test('the context is as large as the last prompt sent, against the window', () => {
    const f = applyRequest(WITH_WINDOW, [request(100_000), request(120_000)], 'm')
    expect(f.contextTokens).toBe(120_902)
    expect(f.contextPercent).toBe(60)
  })

  test('a request that called the advisor does not size the context: its prompt is about twice the conversation', () => {
    const f = applyRequest(WITH_WINDOW, [request(100_000), request(200_000, { isAdvisor: true })], 'm')
    expect(f.contextTokens).toBe(100_902)
    // It is in the turn and the chart all the same.
    expect(f.last?.cacheRead).toBe(300_000)
    expect(recentOf(f).at(-1)?.isAdvisor).toBe(true)
    // Only an advisor's request so far: the context is left as it was.
    const only = applyRequest(WITH_WINDOW, [request(200_000, { isAdvisor: true })], 'm')
    expect(only.contextTokens).toBe(20_000)
    expect(only.contextPercent).toBe(10)
  })

  test('before the window is known the tokens are kept and no percent is made up', () => {
    const f = applyRequest(initialFacts, [request(100_000)], 'm')
    expect(f.contextTokens).toBe(100_902)
    expect(f.contextPercent).toBeNull()
  })

  test('growing heavy mid-turn counts, as a measure would', () => {
    const f = applyRequest(WITH_WINDOW, [request(150_000)], 'm')
    expect(f.hasGrown).toBe(true)
    expect(applyRequest(WITH_WINDOW, [request(10_000)], 'm').hasGrown).toBe(false)
  })

  test('the end of the turn puts the API’s own figures in, and the chart keeps each request once', () => {
    const requests = [request(100_000), request(101_000)]
    const running = applyRequest(WITH_WINDOW, requests, 'm')
    const usage = { input_tokens: 4, output_tokens: 600, cache_read_input_tokens: 201_000, cache_creation_input_tokens: 1_800, model: 'm' }
    const ended = applyTurn(running, turnTokens(usage, [100_902, 101_902]), 1_000, 1, 10, false, requests)
    expect(ended.isLastRunning).toBe(false)
    expect(ended.turns).toBe(1)
    expect(ended.session.turns).toBe(1)
    expect(recentOf(ended)).toHaveLength(2)
    expect(ended.last).toEqual(running.last)
  })

  test('a turn that was cut off keeps the earlier turns in the chart, and the next turn takes its place', () => {
    const first = applyTurn(applyRequest(WITH_WINDOW, [request(90_000)], 'm'), turnTokens({ input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 900, model: 'm' }, [90_902]), 1, 0, 0, false, [request(90_000)])
    // The second turn is under way, and has had two requests.
    const second = applyRequest(first, [request(91_000), request(92_000)], 'm')
    expect(recentOf(second).map(r => [r.turn, r.cacheRead])).toEqual([
      [1, 90_000],
      [2, 91_000],
      [2, 92_000],
    ])
    // One more request arrives: the turn's rows are made again from all it has, not added to.
    const third = applyRequest(second, [request(91_000), request(92_000), request(93_000)], 'm')
    expect(recentOf(third).map(r => [r.turn, r.cacheRead])).toEqual([
      [1, 90_000],
      [2, 91_000],
      [2, 92_000],
      [2, 93_000],
    ])
  })

  test('a new prompt says the figures are no longer a running turn’s', () => {
    const running = applyRequest(WITH_WINDOW, [request(100_000)], 'm')
    expect(applyPrompt(running, 0, 300_000, 50_000, 10).isLastRunning).toBe(false)
  })
})

describe('a turn in progress, on screen', () => {
  const usageOf = (cacheRead: number) => ({ input_tokens: 2, output_tokens: 300, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 900, model: 'm' })

  test('the band grows request by request, before the turn ends, and says the figure is a turn’s so far', async ($, on) => {
    const options = { stepUsage: usageOf(100_000) }
    engine(on, options)
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    const band = await $.ui.mount({ ...bandProps({ isWorking: true }), surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /^20k\// })).toBeDefined()
    // Nothing of the turn yet: the figures are the last turn’s, named as a turn’s total.
    expect(await band.find({ type: 'Text', text: '—' })).toBeDefined()

    await runStep($ as never)
    expect(await band.find({ type: 'Text', text: /^101k\// })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '今回（途中の合計）' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '今回（1ターンの合計）' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '1 回' })).toBeDefined()

    options.stepUsage = usageOf(120_000)
    await runStep($ as never)
    expect(await band.find({ type: 'Text', text: /^121k\// })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '2 回' })).toBeDefined()
  })

  test('the turn’s end gives the finished label, and the chart is in the pane without a request twice', async ($, on) => {
    const options = { stepUsage: usageOf(100_000) }
    engine(on, options)
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /まだありません。ターンが終わると出ます/ })).toBeDefined()

    await runStep($ as never)
    await runStep($ as never)
    // Two requests of a turn still under way are already in the chart.
    expect((await pane.findAll({ type: 'Raster' })).length).toBe(6)

    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: usageOf(200_000) } as never)
    expect((await pane.findAll({ type: 'Raster' })).length).toBe(6)

    const band = await $.ui.mount({ ...bandProps({ isWorking: false }), surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: '今回（1ターンの合計）' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '今回（途中の合計）' })).toBeUndefined()
  })

  test('where the engine says no turn is running the label is the finished one, whatever was left in the facts', async ($, on) => {
    engine(on, { stepUsage: usageOf(100_000) })
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    await runStep($ as never)
    // The turn was cut off: no end came, and the band is no longer told it is working.
    const band = await $.ui.mount({ ...bandProps({ isWorking: false }), surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: '今回（1ターンの合計）' })).toBeDefined()
  })

  test('a subagent’s steps are not the conversation’s: the band does not move for them', async ($, on) => {
    engine(on, { stepUsage: usageOf(100_000) })
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    const band = await $.ui.mount({ ...bandProps({ isWorking: true }), surface: 'terminal' })
    await runStep($ as never, { agentId: 'a1' })
    expect(await band.find({ type: 'Text', text: /^20k\// })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '今回（途中の合計）' })).toBeUndefined()
  })
})

// The pane's list of what is heavy follows the replies too, without a reply waiting for it.

describe('what is heavy, while the analysis pane is open', () => {
  const usage = { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 900, model: 'm' }
  const end = ($: { turn: { complete: (e: never) => Promise<unknown> } }, id: string) =>
    $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage } as never)

  test('the end of a reply does not wait for it; a moment later the list is made again from the conversation as it is then', async ($, on) => {
    const calls = engine(on, { conversationTokens: 12_000 })
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await band.press({ key: 'analysis' })
    const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: '12k tok' })).toBeDefined()

    calls.conversation = 30_000
    const asked = calls.usageAsked
    await end($ as never, 't1')
    // The reply has ended and nothing was asked of the engine in its way.
    expect(calls.usageAsked).toBe(asked)
    expect(await pane.find({ type: 'Text', text: '12k tok' })).toBeDefined()

    await calls.clock.advance(1)
    expect(calls.usageAsked).toBe(asked + 1)
    expect(await pane.find({ type: 'Text', text: '30k tok' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '12k tok' })).toBeUndefined()
  })

  test('every reply does it again, within the minute', async ($, on) => {
    const calls = engine(on, { conversationTokens: 12_000 })
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    await $.command.run({ command: 'tokenomics', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

    // Each reply leaves one refresh for after it (a reply may ask for other things of its own, such as the size of a conversation
    // an offer needs: those are not counted here).
    for (const id of ['t1', 't2', 't3', 't4']) {
      await end($ as never, id)
      const before = calls.usageAsked
      await calls.clock.advance(1)
      expect(calls.usageAsked).toBe(before + 1)
    }
  })

  test('two replies before the first refresh has run are one refresh, not two on top of each other', async ($, on) => {
    const calls = engine(on)
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    await $.command.run({ command: 'tokenomics', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

    await end($ as never, 't1')
    await end($ as never, 't2')
    const before = calls.usageAsked
    await calls.clock.advance(1)
    expect(calls.usageAsked).toBe(before + 1)
  })

  test('with no analysis pane up nothing is left for after the reply: shut, never opened, or the settings pane', async ($, on) => {
    const calls = engine(on)
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    const run = (args: string) =>
      $.command.run({ command: 'tokenomics', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    // What a reply asks for in its own hook (the first one learns what an empty session holds; an offer may want the size of the
    // conversation) is not in question: only what is left for after it.
    const leftAfter = async (id: string): Promise<number> => {
      await end($ as never, id)
      const before = calls.usageAsked
      await calls.clock.advance(1)
      return calls.usageAsked - before
    }

    // Never opened.
    expect(await leftAfter('t0')).toBe(0)
    expect(await leftAfter('t1')).toBe(0)

    // Open, then shut.
    await run('')
    expect(await leftAfter('t2')).toBe(1)
    await (await $.ui.mount({ ...paneProps, surface: 'terminal' })).press({ key: 'close' })
    expect(await leftAfter('t3')).toBe(0)

    // The settings pane is up, and the list is not in it.
    await run('settings')
    expect(await leftAfter('t4')).toBe(0)
  })

  test('a pane the terminal could not seat is not up', async ($, on) => {
    const calls = engine(on, { isPlaced: false })
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    await $.command.run({ command: 'tokenomics', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 60 } } as never)
    expect(calls.opened).toEqual(['tokenomics'])

    await end($ as never, 't1')
    const before = calls.usageAsked
    await calls.clock.advance(1)
    expect(calls.usageAsked).toBe(before)
  })

  test('after a minute the reply’s own refresh stands, and the later one is not added to it', async ($, on) => {
    const calls = engine(on)
    await $.session.start(START)
    await $.session.measure(measure.context(10))
    await $.command.run({ command: 'tokenomics', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

    await calls.clock.advance(61_000)
    const asked = calls.usageAsked
    await end($ as never, 't1')
    expect(calls.usageAsked).toBe(asked + 1)
    await calls.clock.advance(1)
    expect(calls.usageAsked).toBe(asked + 1)
  })
})
