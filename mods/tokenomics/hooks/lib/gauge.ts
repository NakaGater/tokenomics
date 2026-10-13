import type { Facts } from '../../types'

import { formatTokens } from './format'
import { type Cell, EIGHTHS, TERMINAL_DEFAULT, mix, packCells } from './raster'

const GREEN = 0x4cc38a
const AMBER = 0xf2c94c
const RED = 0xeb5757
/** The line left where the gauge is empty: a mid grey that shows on a dark or a light background. */
const TRACK = 0x6b7280

/** Green at the start of the gauge, amber about two thirds along, red at the end: the danger is in the place, not only the length. */
const colorAt = (t: number): number => (t < 0.6 ? mix(GREEN, AMBER, t / 0.6) : mix(AMBER, RED, (t - 0.6) / 0.4))

/** One row of cells: filled to `percent` in eighths of a cell, the rest a thin line. */
export const gaugeGrid = (percent: number, columns: number): Cell[] => {
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * columns
  return Array.from({ length: columns }, (_, i) => {
    const t = columns === 1 ? 0 : i / (columns - 1)
    const part = filled - i
    if (part >= 1) return { ch: '█', fg: colorAt(t), bg: TERMINAL_DEFAULT }
    if (part >= 1 / 8) return { ch: EIGHTHS[Math.round(part * 8) - 1] ?? '█', fg: colorAt(t), bg: TERMINAL_DEFAULT }
    return { ch: '▁', fg: TRACK, bg: TERMINAL_DEFAULT }
  })
}

/**
 * What the gauge reads: how far the conversation is from the size the engine auto-compacts at, so a full gauge is a
 * compaction. Where there is no such size (auto-compaction off, or not read yet) it is the share of the window.
 */
export type Fill = {
  percent: number
  /** The conversation's size and the size the percent is counted against; null while either is unknown. */
  tokens: number | null
  limit: number | null
  /** The limit is where auto-compaction runs, not the end of the window. */
  isCompactAt: boolean
}

export const fillOf = (f: Facts): Fill => {
  const at = f.isAutoCompactEnabled === false ? null : f.autoCompactThreshold
  if (f.contextTokens !== null && at !== null && at > 0) {
    // Rounded down: a full gauge is not shown until the compaction is due.
    return { percent: Math.min(100, Math.floor((f.contextTokens / at) * 100)), tokens: f.contextTokens, limit: at, isCompactAt: true }
  }
  return { percent: f.contextPercent ?? 0, tokens: f.contextTokens, limit: f.contextWindow, isCompactAt: false }
}

/** `73k/196k` beside the percent; nothing while either figure is unknown. */
export const fillTokens = (fill: Fill): string | null =>
  fill.tokens === null || fill.limit === null ? null : `${formatTokens(fill.tokens)}/${formatTokens(fill.limit)}`

/** `RasterProps.cells` for the gauge. */
export const gaugeCells = (percent: number, columns: number): string => packCells(gaugeGrid(percent, columns))
