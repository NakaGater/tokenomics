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

/** `RasterProps.cells` for the gauge. */
export const gaugeCells = (percent: number, columns: number): string => packCells(gaugeGrid(percent, columns))
