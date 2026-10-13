import { CAT_COUNTS, CAT_PNG } from './cat-art'
import { type Cell, BLANK, QUADRANTS, TERMINAL_DEFAULT, packCells } from './raster'

/**
 * The cat's picture: 16 cells wide and 4 tall, each cell two points across and two down. A point is half a cell
 * wide and half a cell tall, so it stands twice as tall as it is wide; the art is drawn for that.
 */
export const CAT_COLS = 16
export const CAT_ROWS = 4
const W = CAT_COLS * 2
const H = CAT_ROWS * 2

export type Pose = 'run' | 'sleep' | 'jump'

/** How many frames a pose cycles through. */
export const FRAMES: Record<Pose, number> = { run: 4, sleep: 2, jump: 4 }

/**
 * What the cat is doing at one moment: a pose, the frame of it, and whether it is sweating. A picture has more
 * frames than the cells do, so `step`, how many frames have been shown, is kept too, and whether the cat walks
 * rather than runs; the cells ignore both.
 */
export type Look = { pose: Pose; frame: number; isSweating: boolean; step?: number; isWalking?: boolean }

/** An orange cat, drawn as a silhouette: one fur color and a dark eye. */
const FUR = 0xe8913a
const EYE = 0x2a1b14
const SWEAT = 0x7fd0ff
const SLEEP = 0xa8b4ff
const SPARKLE = 0xffe066

type Canvas = string[][]

/** `o` is fur, `k` an eye, `.` nothing. */
const blankCanvas = (): Canvas => Array.from({ length: H }, () => Array.from({ length: W }, () => '.'))

/** Lays `rows` on the canvas at (x, y); a `.` leaves what is there, and what falls outside is dropped. */
const put = (c: Canvas, x: number, y: number, rows: readonly string[]): void => {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx]
      const line = c[y + dy]
      if (ch === undefined || ch === '.' || line === undefined || x + dx < 0 || x + dx >= W) continue
      line[x + dx] = ch === '#' ? 'o' : ch
    }
  })
}

/** Small things that are not part of the cat: a glyph and its color, set in a whole cell that nothing else is in. */
type Marks = Map<number, Cell>

const isEmptyCell = (c: Canvas, col: number, row: number): boolean =>
  [0, 1].every(dy => [0, 1].every(dx => c[row * 2 + dy]?.[col * 2 + dx] === '.'))

const mark = (c: Canvas, marks: Marks, col: number, row: number, ch: string, fg: number): void => {
  if (col < 0 || col >= CAT_COLS || row < 0 || row >= CAT_ROWS || !isEmptyCell(c, col, row)) return
  marks.set(row * CAT_COLS + col, { ch, fg, bg: TERMINAL_DEFAULT })
}

// Two broad ears, a round face, a muzzle to the right: 9 across and 5 down.
const HEAD = ['..#...#..', '.###.###.', '#########', '#########', '.#######.']

/** An eye on the face: set on the first spot where its whole cell is face, so the cell can be two colors. */
const eye = (c: Canvas, x: number, y: number): void => {
  for (const dx of [6, 5, 4]) {
    const px = x + dx
    const py = y + 2
    const col = px >> 1
    const row = py >> 1
    const isFace = [0, 1].every(oy =>
      [0, 1].every(ox => (ox === px - col * 2 && oy === py - row * 2) || c[row * 2 + oy]?.[col * 2 + ox] === 'o'),
    )
    if (isFace) {
      put(c, px, py, ['k'])
      return
    }
  }
}

const head = (c: Canvas, x: number, y: number): void => {
  put(c, x, y, HEAD)
  eye(c, x, y)
}

// A long body: the back is level, the belly tucked up between the hips and the chest.
const TORSO = ['..###############', '#################', '###..........####']
const TAIL = ['##', '.###', '...###']

// Four poses of a gallop. `up` lifts the whole cat by that many points (a jump).
const stretched = (c: Canvas, up: number): void => {
  head(c, 23, 1 - up)
  put(c, 6, 3 - up, TORSO)
  put(c, 1, 1 - up, TAIL)
  put(c, 1, 6 - up, ['..###', '###'])
  put(c, 24, 6 - up, ['####', '...###'])
  put(c, 0, 7 - up, ['##'])
  put(c, 29, 7 - up, ['###'])
}

const landing = (c: Canvas): void => {
  head(c, 22, 0)
  put(c, 5, 2, TORSO)
  put(c, 0, 1, TAIL)
  put(c, 19, 5, ['#..#', '#..##', '##..#'])
  put(c, 10, 5, ['#', '##', '.##'])
  put(c, 6, 5, ['#', '#', '##'])
}

const gathered = (c: Canvas): void => {
  head(c, 21, 0)
  put(c, 6, 1, ['.....########', '..############..', '################.', '###..........####'])
  put(c, 1, 0, ['##', '.##', '..###', '....##'])
  put(c, 8, 5, ['#..#', '##.##'])
  put(c, 17, 5, ['#..#', '##.##'])
}

const pushing = (c: Canvas): void => {
  head(c, 23, 1)
  put(c, 6, 2, TORSO)
  put(c, 0, 0, TAIL)
  put(c, 3, 5, ['#..#', '#..#', '##.##'])
  put(c, 21, 5, ['.##', '..###', '....##'])
}

const drawRun = (c: Canvas, marks: Marks, frame: number, isSweating: boolean): void => {
  switch (frame % FRAMES.run) {
    case 0:
      stretched(c, 0)
      break
    case 1:
      landing(c)
      break
    case 2:
      gathered(c)
      break
    default:
      pushing(c)
  }
  if (isSweating) {
    // Drops fly off the brow, one then the other.
    const odd = frame % 2
    mark(c, marks, 10 - odd, 0, odd === 0 ? '▗' : '▖', SWEAT)
    mark(c, marks, 8 + odd, 0, odd === 0 ? '▖' : '▝', SWEAT)
  }
}

// Curled up, head on its paws: a loaf with a tail wrapped round it. The back dips where the head begins.
const drawSleep = (c: Canvas, marks: Marks, frame: number): void => {
  const breathe = frame % 2
  if (breathe === 0) put(c, 8, 4, ['########'])
  put(c, 4, 5, ['###############'])
  put(c, 3, 6, ['#################'])
  put(c, 1, 7, ['##########################'])
  put(c, 0, 5, ['#', '##'])
  put(c, 20, 3, HEAD)
  put(c, 27, 7, ['####'])
  // The eye is a thin line: shut.
  marks.set(2 * CAT_COLS + 13, { ch: '▂', fg: EYE, bg: FUR })
  // z Z, drifting up and to the right.
  mark(c, marks, 12 + breathe, 0, 'z', SLEEP)
  mark(c, marks, 14 + breathe, 0, 'Z', SLEEP)
}

const drawJump = (c: Canvas, marks: Marks, frame: number): void => {
  const f = frame % FRAMES.jump
  if (f === 0) gathered(c)
  else if (f === 1) stretched(c, 1)
  else if (f === 2) pushing(c)
  else landing(c)
  const glints: readonly (readonly [number, number, string])[] =
    f === 0
      ? [[0, 3, '+'], [14, 3, '+']]
      : f === 1
        ? [[2, 0, '*'], [7, 3, '+'], [14, 3, '*']]
        : f === 2
          ? [[3, 3, '*'], [10, 0, '+'], [14, 2, '+']]
          : [[1, 3, '+'], [8, 0, '*']]
  for (const [col, row, ch] of glints) mark(c, marks, col, row, ch, SPARKLE)
}

const paint = (look: Look): { canvas: Canvas; marks: Marks } => {
  const canvas = blankCanvas()
  const marks: Marks = new Map()
  if (look.pose === 'sleep') drawSleep(canvas, marks, look.frame)
  else if (look.pose === 'jump') drawJump(canvas, marks, look.frame)
  else drawRun(canvas, marks, look.frame, look.isSweating)
  return { canvas, marks }
}

/** Two points across and two down, as one cell: a quarter block. An eye sits on a cell of face, so fur is its other color. */
const cellOf = (tl: string, tr: string, bl: string, br: string): Cell => {
  const quarters = [tl, tr, bl, br]
  const hasEye = quarters.includes('k')
  let bits = 0
  quarters.forEach((q, i) => {
    if (hasEye ? q === 'k' : q === 'o') bits |= 1 << i
  })
  if (bits === 0) return BLANK
  return { ch: QUADRANTS[bits] ?? ' ', fg: hasEye ? EYE : FUR, bg: hasEye ? FUR : TERMINAL_DEFAULT }
}

/** The look as terminal cells, row by row. */
export const catGrid = (look: Look): Cell[] => {
  const { canvas, marks } = paint(look)
  const cells: Cell[] = []
  for (let row = 0; row < CAT_ROWS; row++) {
    for (let col = 0; col < CAT_COLS; col++) {
      const at = (dx: number, dy: number): string => canvas[row * 2 + dy]?.[col * 2 + dx] ?? '.'
      cells.push(marks.get(row * CAT_COLS + col) ?? cellOf(at(0, 0), at(1, 0), at(0, 1), at(1, 1)))
    }
  }
  return cells
}

const memo = new Map<string, string>()

/** `RasterProps.cells` for a look. */
export const catCells = (look: Look): string => {
  const key = `${look.pose}:${look.frame % FRAMES[look.pose]}:${look.isSweating}`
  let packed = memo.get(key)
  if (packed === undefined) {
    packed = packCells(catGrid({ ...look, frame: look.frame % FRAMES[look.pose] }))
    memo.set(key, packed)
  }
  return packed
}

/** How many pictures each row of the sheet plays, in the order the tool put them (tools/cat): the in-betweens are counted. */
export const PICTURES = CAT_COUNTS

/**
 * A look as a picture, a PNG in base64, for an `Image` where the terminal can draw one: the cat of tools/cat/sheet.png,
 * running, walking, sweating, asleep or leaping for joy, one picture a step.
 */
export const catPng = (look: Look): string => {
  const step = look.step ?? look.frame
  const row =
    look.pose === 'jump' ? 'jump' : look.pose === 'sleep' ? 'sleep' : look.isSweating ? 'sweat' : look.isWalking === true ? 'walk' : 'run'
  return CAT_PNG[`${row}:${step % CAT_COUNTS[row]}`] ?? ''
}

/** The points of a look as letters (`o` fur, `k` eye), for a test or a glance. */
export const catPoints = (look: Look): string[] => paint(look).canvas.map(row => row.join(''))
