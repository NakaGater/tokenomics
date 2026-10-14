import { CAT_PNG } from './cat-art'
import { FRAME_ROWS, MARK_COLORS, POINTS_H, POINTS_W, POINT_COLORS, type Frame, type Row } from './clawd'
import { type Cell, BLANK, QUADRANTS, TERMINAL_DEFAULT, packCells } from './raster'

/**
 * The mascot's picture, Clawd (hooks/lib/clawd.ts): 16 cells wide and 4 tall, each cell two points across and two down.
 * A point is half a cell wide and half a cell tall, so it stands twice as tall as it is wide; the art is drawn for that.
 */
export const CAT_COLS = POINTS_W / 2
export const CAT_ROWS = POINTS_H / 2

export type Pose = 'run' | 'sleep' | 'jump'

/** How many pictures a row of the art plays: the cells show the same ones as the pictures do. */
export const PICTURES: Record<Row, number> = {
  run: FRAME_ROWS.run.length,
  walk: FRAME_ROWS.walk.length,
  sweat: FRAME_ROWS.sweat.length,
  sleep: FRAME_ROWS.sleep.length,
  jump: FRAME_ROWS.jump.length,
}

/** How many frames a pose cycles through. */
export const FRAMES: Record<Pose, number> = { run: PICTURES.run, sleep: PICTURES.sleep, jump: PICTURES.jump }

/**
 * What Clawd is doing at one moment: a pose, the frame of it, whether it is sweating and whether it walks rather than runs.
 * `step`, how many frames have been shown, says which picture of its row comes next; without it the frame does.
 */
export type Look = { pose: Pose; frame: number; isSweating: boolean; step?: number; isWalking?: boolean }

const rowOf = (look: Look): Row =>
  look.pose === 'jump' ? 'jump' : look.pose === 'sleep' ? 'sleep' : look.isSweating ? 'sweat' : look.isWalking === true ? 'walk' : 'run'

/** The picture of a look: its row and its place in it (a step past the end of the row is its start again). */
const pictureOf = (look: Look): { row: Row; index: number; frame: Frame } => {
  const row = rowOf(look)
  const index = (look.step ?? look.frame) % PICTURES[row]
  return { row, index, frame: FRAME_ROWS[row][index] ?? FRAME_ROWS[row][0]! }
}

/**
 * Two points across and two down, as one cell: a quarter block. A cell holds two colours at most. Where it holds a second one
 * on the body (an eye) the glyph is that one, on the body's colour; where a point is empty the terminal's own background shows.
 */
const cellOf = (quarters: readonly string[]): Cell => {
  const letters = [...new Set(quarters.filter(q => q !== '.'))]
  if (letters.length === 0) return BLANK
  const isFull = !quarters.includes('.')
  const drawn = letters.length === 2 && isFull ? letters.find(l => l !== 'o') : letters.includes('o') ? 'o' : letters[0]
  const ground = letters.length === 2 && isFull ? letters.find(l => l !== drawn) : undefined
  let bits = 0
  quarters.forEach((q, i) => {
    if (q === drawn) bits |= 1 << i
  })
  const colorOf = (letter: string | undefined): number => POINT_COLORS[letter as keyof typeof POINT_COLORS] ?? TERMINAL_DEFAULT
  return { ch: QUADRANTS[bits] ?? ' ', fg: colorOf(drawn), bg: colorOf(ground) }
}

/** The look as terminal cells, row by row. */
export const catGrid = (look: Look): Cell[] => {
  const { frame } = pictureOf(look)
  const marks = new Map(frame.marks.map(m => [m.row * CAT_COLS + m.col, m]))
  const cells: Cell[] = []
  for (let row = 0; row < CAT_ROWS; row++) {
    for (let col = 0; col < CAT_COLS; col++) {
      const mark = marks.get(row * CAT_COLS + col)
      if (mark !== undefined) {
        cells.push({ ch: mark.ch, fg: MARK_COLORS[mark.color], bg: TERMINAL_DEFAULT })
        continue
      }
      const at = (dx: number, dy: number): string => frame.points[row * 2 + dy]?.[col * 2 + dx] ?? '.'
      cells.push(cellOf([at(0, 0), at(1, 0), at(0, 1), at(1, 1)]))
    }
  }
  return cells
}

const memo = new Map<string, string>()

/** `RasterProps.cells` for a look. */
export const catCells = (look: Look): string => {
  const { row, index } = pictureOf(look)
  const key = `${row}:${index}`
  let packed = memo.get(key)
  if (packed === undefined) {
    packed = packCells(catGrid(look))
    memo.set(key, packed)
  }
  return packed
}

/**
 * A look as a picture, a PNG in base64, for an `Image` where the terminal can draw one: the same points as the cells, each a
 * block of pixels, with the letters and signs set in their cells (tools/clawd).
 */
export const catPng = (look: Look): string => {
  const { row, index } = pictureOf(look)
  return CAT_PNG[`${row}:${index}`] ?? ''
}

/** The points of a look as letters (`o` body, `k` eye, `s` sweat), for a test or a glance. */
export const catPoints = (look: Look): string[] => [...pictureOf(look).frame.points]
