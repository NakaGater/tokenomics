import { describe, expect, test } from 'claude-code/testing'

import type { Facts, RequestUsage } from '../types'

import {
  INPUT_COLOR,
  INPUT_ROWS,
  OUTPUT_COLOR,
  OUTPUT_ROWS,
  columnCells,
  columnText,
  columnsFitting,
  eighthsFor,
  inputOf,
  inputScale,
  outputScale,
} from '../hooks/lib/chart'
import { applyCleared, applyTurn, initialFacts, recentOf } from '../hooks/lib/facts'
import { turnTokens } from '../hooks/lib/format'

import { decodeCells, engine, paneProps, runStep } from './kit'

const req = (turn: number, cacheRead: number, cacheWrite: number, input: number, output: number, isAdvisor = false): RequestUsage => ({
  turn,
  cacheRead,
  cacheWrite,
  input,
  output,
  isAdvisor,
})

/** The last ten requests of a real session: the ninth called the advisor. */
const REAL: RequestUsage[] = [
  req(40, 281_079, 1_336, 2, 1_082),
  req(40, 282_415, 1_154, 2, 645),
  req(42, 283_569, 10_770, 2, 1_404),
  req(42, 294_339, 1_564, 2, 1_248),
  req(42, 295_903, 1_332, 2, 650),
  req(43, 297_235, 776, 2, 4_173),
  req(43, 298_011, 4_664, 2, 192),
  req(43, 302_675, 3_284, 2, 4_845),
  req(43, 618_106, 7_478, 4, 529, true),
  req(43, 312_147, 2_302, 2, 1_106),
]

describe('the charts of the last requests', () => {
  test('the prompt axis starts under the smallest request, at a round number, and stops over the largest', () => {
    // The advisor's request, twice the conversation, does not set the scale.
    expect(inputScale(REAL)).toEqual({ base: 265_000, top: 315_000, row: 5_000 })
    const scale = inputScale(REAL)
    if (scale === null) throw new Error('no scale')
    const heights = REAL.filter(r => !r.isAdvisor).map(r => eighthsFor(inputOf(r), scale, INPUT_ROWS))
    // Even the smallest is at least a row high; none passes the top.
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(8)
    expect(Math.max(...heights)).toBeLessThanOrEqual(INPUT_ROWS * 8)
  })

  test('the growth shows: each request is as tall as the one before it, or taller', () => {
    const scale = inputScale(REAL)
    if (scale === null) throw new Error('no scale')
    const heights = REAL.filter(r => !r.isAdvisor).map(r => eighthsFor(inputOf(r), scale, INPUT_ROWS))
    expect(heights).toEqual([...heights].sort((a, b) => a - b))
    expect(heights[heights.length - 1]).toBeGreaterThan((heights[0] ?? 0) * 2)
  })

  test('the output axis is its own, from nothing; whatever was output shows at least a sliver', () => {
    expect(outputScale(REAL)).toEqual({ base: 0, top: 6_000, row: 1_500 })
    const scale = outputScale(REAL)
    if (scale === null) throw new Error('no scale')
    expect(eighthsFor(0, scale, OUTPUT_ROWS)).toBe(0)
    expect(eighthsFor(1, scale, OUTPUT_ROWS)).toBe(1)
    expect(eighthsFor(4_845, scale, OUTPUT_ROWS)).toBe(26)
    // Over the top is cut at it.
    expect(eighthsFor(99_999, scale, OUTPUT_ROWS)).toBe(OUTPUT_ROWS * 8)
  })

  test('a wide range starts at nothing; one request is still a chart, and none is a clean refusal', () => {
    expect(inputScale([req(1, 10_000, 0, 2, 0), req(2, 300_000, 0, 2, 0)])?.base).toBe(0)
    expect(inputScale([req(1, 100_000, 0, 2, 0)])).not.toBeNull()
    expect(inputScale([])).toBeNull()
    expect(outputScale([])).toBeNull()
    // Nothing output at all is still an axis.
    expect(outputScale([req(1, 100_000, 0, 2, 0)])).toEqual({ base: 0, top: 4, row: 1 })
  })

  test('a column is one color of full cells under a partial one, three cells across', () => {
    const cells = decodeCells(columnCells(22, 10, INPUT_COLOR))
    // Ten rows of three cells; 22 eighths: two full rows and six eighths.
    expect(cells).toHaveLength(30)
    const rows = Array.from({ length: 10 }, (_, row) => cells.slice(row * 3, row * 3 + 3).map(c => c.ch).join(''))
    expect(rows.slice(0, 7).every(r => r === '   ')).toBe(true)
    expect(rows.slice(7)).toEqual(['▆▆▆', '███', '███'])
    expect(new Set(cells.filter(c => c.ch !== ' ').map(c => c.fg))).toEqual(new Set([INPUT_COLOR]))
    expect(new Set(decodeCells(columnCells(5, 4, OUTPUT_COLOR)).filter(c => c.ch !== ' ').map(c => c.fg))).toEqual(new Set([OUTPUT_COLOR]))
    expect(INPUT_COLOR).not.toBe(OUTPUT_COLOR)
  })

  test('a request that called the advisor is cut at the top and marked', () => {
    expect(columnText(INPUT_ROWS * 8, INPUT_ROWS, true)[0]).toBe('▲▲▲')
    expect(columnText(INPUT_ROWS * 8, INPUT_ROWS, true)[1]).toBe('███')
    expect(columnText(22, INPUT_ROWS, false)[0]).toBe('   ')
    expect(inputOf(REAL[8] as RequestUsage)).toBe(625_588)
  })

  test('as many columns as the pane has room for, never none', () => {
    expect([columnsFitting(100, 10), columnsFitting(56, 10), columnsFitting(20, 10), columnsFitting(5, 10), columnsFitting(100, 3)]).toEqual([10, 9, 2, 1, 3])
  })

  test('the last ten requests are kept across turns, and /clear starts them over', () => {
    const usage = { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, model: 'm' }
    const sized = (n: number) => ({ input: 2, cacheWrite: 100, cacheRead: 1_000 + n, output: 10, isAdvisor: false })
    let f: Facts = applyTurn(initialFacts, turnTokens(usage), 1, 0, 0, false, [sized(0), sized(1), sized(2), sized(3), sized(4), sized(5), sized(6)])
    f = applyTurn(f, turnTokens(usage), 2, 0, 0, false, [sized(7), sized(8), sized(9), sized(10), sized(11)])
    const kept = recentOf(f)
    expect(kept).toHaveLength(10)
    expect(kept.map(r => r.cacheRead - 1_000)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(kept.map(r => r.turn)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2])
    expect(recentOf(applyCleared(f))).toEqual([])
    // A state kept from an older build has none, and reads as none.
    const { recent: _recent, ...older } = initialFacts
    expect(recentOf(older as unknown as Facts)).toEqual([])
  })
})

describe('the charts in the pane', () => {
  const turn = async ($: Parameters<typeof runStep>[0] & { turn: { complete: (e: never) => Promise<unknown> } }, options: { stepUsage: NonNullable<Parameters<typeof engine>[1]>['stepUsage'] }, reads: number[]) => {
    for (const read of reads) {
      options.stepUsage = { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: read, cache_creation_input_tokens: 900, model: 'm' }
      await runStep($)
    }
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: { input_tokens: 4, output_tokens: 600, cache_read_input_tokens: 1, cache_creation_input_tokens: 1_800, model: 'm' } } as never)
  }

  test('a column for each request of the last turns, with the turn marked where it begins', async ($, on) => {
    const options = { stepUsage: { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 900, model: 'm' } }
    engine(on, options)
    const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: '直近 10 回のリクエスト' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /まだありません。リクエストが返ると出ます/ })).toBeDefined()

    await turn($ as never, options, [100_000, 101_000])
    await turn($ as never, options, [102_000, 103_000, 104_000])

    // Five columns in each of two charts, and two swatches.
    expect((await pane.findAll({ type: 'Raster' })).length).toBe(12)
    expect(await pane.find({ type: 'Text', text: /入力（キャッシュ読み ＋ キャッシュ書き込み ＋ キャッシュなし）/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '出力' })).toBeDefined()
    // The turn is named where it begins; the totals stand under the columns.
    expect(await pane.find({ type: 'Text', text: /T1/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /T2/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /入力 tok　縦軸の下端 .*・1段/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /出力 tok　0 から・1段/ })).toBeDefined()
    // The chart says what the requests were, one by one: the row that said how many is not repeated beside it.
    expect(await pane.find({ type: 'Text', text: '今回のリクエスト' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '今回の入力' })).toBeDefined()
  })

  test('where there is no grid of colored cells the columns are characters', async ($, on) => {
    const options = { stepUsage: { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 900, model: 'm' } }
    engine(on, options)
    const pane = await $.ui.mount({ ...paneProps, surface: 'desktop' })
    await turn($ as never, options, [100_000, 140_000])
    expect(await pane.find({ type: 'Raster' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '███' })).toBeDefined()
  })
})
