import type { RequestUsage } from '../../types'

import { type Cell, BLANK, TERMINAL_DEFAULT, packCells } from './raster'

/**
 * The charts of the last requests: one column a request, oldest at the left, in two charts one above the other so that the
 * columns line up. The upper is the prompt (cache reads, cache writes and what was not cached together), on an axis that starts
 * under the smallest request, not at nothing, so that the slow growth of a conversation shows. The lower is the output, which is
 * a hundredth of that, on an axis from nothing of its own. The pane says where each axis starts.
 */

export const INPUT_COLOR = 0x3b82f6
export const OUTPUT_COLOR = 0x22c55e

export const INPUT_ROWS = 10
export const OUTPUT_ROWS = 4
/** Cells across a column's bar, and the cells a column takes with the space beside it. */
export const BAR_CELLS = 3
export const COLUMN_CELLS = 5
/** The axis's labels take this much room at the left. */
export const AXIS_CELLS = 6

/** What the request sent: all of its prompt, whichever way the API counted it. */
export const inputOf = (r: RequestUsage): number => r.input + r.cacheWrite + r.cacheRead

/** The smallest round number (1, 1.5, 2, 3, 4, 5, 6 or 8 times a power of ten) that is at least `min`. */
const niceStep = (min: number): number => {
  for (let power = 1; ; power *= 10) {
    for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8]) if (m * power >= min) return m * power
  }
}

/** Where an axis starts, how many tokens a row is, and where it ends. */
export type Scale = { base: number; top: number; row: number }

/**
 * The axis of the prompt chart: a row is a round number of tokens, the top is the first row line above the largest request, and the
 * base is `rows` rows under it (nothing below zero). The smallest request is at least a row high. A request that called the advisor
 * reads about twice the conversation, so it is left out of the scale and cut at the top.
 */
export const inputScale = (requests: readonly RequestUsage[], rows = INPUT_ROWS): Scale | null => {
  const counted = requests.filter(r => !r.isAdvisor)
  const sizes = (counted.length > 0 ? counted : requests).map(inputOf)
  if (sizes.length === 0) return null
  const hi = Math.max(...sizes)
  const lo = Math.min(...sizes)
  const row = niceStep(Math.max(hi - lo, hi * 0.1) / (rows - 2))
  const base = Math.max(0, Math.ceil(hi / row) * row - rows * row)
  return { base, top: base + rows * row, row }
}

/** The axis of the output chart: from nothing, to the first row line above the largest. */
export const outputScale = (requests: readonly RequestUsage[], rows = OUTPUT_ROWS): Scale | null => {
  if (requests.length === 0) return null
  const most = Math.max(1, ...requests.map(r => r.output))
  const row = niceStep(most / rows)
  return { base: 0, top: row * rows, row }
}

/**
 * How tall a column is, in eighths of a row from the foot of the axis. A value above the base is at least an eighth, so none
 * disappears; a value over the top is cut at it.
 */
export const eighthsFor = (value: number, scale: Scale, rows: number): number => {
  const most = rows * 8
  if (value <= scale.base) return value > 0 ? 1 : 0
  return Math.max(1, Math.min(most, Math.round(((value - scale.base) / scale.row) * 8)))
}

/** The lower eighths of a cell, 1 to 7 filled. */
const LOWER = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'] as const

const glyphFor = (filled: number): string => (filled >= 8 ? '█' : (LOWER[filled - 1] ?? '█'))

/** The glyphs of one column, the top row first: full cells under a partial one, blank above. */
const glyphsOf = (eighths: number, rows: number, isCut: boolean): string[] => {
  const lines: string[] = []
  for (let row = rows - 1; row >= 0; row -= 1) {
    const filled = Math.max(0, Math.min(8, eighths - 8 * row))
    lines.push(filled === 0 ? ' ' : isCut && row === rows - 1 ? '▲' : glyphFor(filled))
  }
  return lines
}

/** `RasterProps.cells` for one column: `rows` rows of `BAR_CELLS` cells in one color, the top row first. */
export const columnCells = (eighths: number, rows: number, color: number, isCut = false): string => {
  const cells: Cell[] = []
  for (const ch of glyphsOf(eighths, rows, isCut)) {
    for (let i = 0; i < BAR_CELLS; i += 1) cells.push(ch === ' ' ? BLANK : { ch, fg: color, bg: TERMINAL_DEFAULT })
  }
  return packCells(cells)
}

/** One column as lines of characters, the top first, for a surface without colored cells. */
export const columnText = (eighths: number, rows: number, isCut = false): string[] =>
  glyphsOf(eighths, rows, isCut).map(ch => ch.repeat(BAR_CELLS))

/** How many columns fit in `columns` cells across the body (never fewer than one). */
export const columnsFitting = (columns: number, most: number): number =>
  Math.max(1, Math.min(most, Math.floor((columns - AXIS_CELLS - 1) / COLUMN_CELLS)))
