/**
 * Clawd, the mascot of Claude Code, drawn in points: 32 across and 10 down. A point is half a cell wide and half a cell tall,
 * so it stands twice as tall as it is wide, as the blocks of Claude Code's own banner do. Two points across and two down are
 * one cell of the terminal, and a cell can hold two colours, so these points are what the cells (hooks/lib/cat.ts) and, cut
 * by tools/clawd, the pictures of a terminal that can draw them both show, exactly.
 */
export const POINTS_W = 32
export const POINTS_H = 10

/** The colours of the points, by letter: `o` the body, `k` an eye, `s` a drop of sweat. A `.` is nothing. */
export const POINT_COLORS = { o: 0xd77757, k: 0x1a1210, s: 0x7fd0ff } as const
/** The colours of the marks: the z's of sleep (`z`) and the sparkles of joy (`y`). */
export const MARK_COLORS = { z: 0xa8b4ff, y: 0xffe066 } as const

export type Row = 'run' | 'walk' | 'sweat' | 'sleep' | 'jump'

/** A letter or a sign set in one whole cell that nothing else is in (`col` and `row` count cells). */
export type Mark = { col: number; row: number; ch: string; color: keyof typeof MARK_COLORS }

/** One picture: `POINTS_H` strings of `POINTS_W` points, and its marks. */
export type Frame = { points: readonly string[]; marks: readonly Mark[] }

type Grid = string[][]
type Arm = number | 'cheer'

/**
 * How Clawd stands: shifted `dx` points across and `dy` down, shortened by `squash`, with the length of each of the four legs,
 * where each arm sits (a number of points down from the top of the body, or thrown up in a V) and how its eyes are.
 */
type Stance = {
  dx?: number
  dy?: number
  squash?: number
  legs?: readonly [number, number, number, number]
  arms?: readonly [Arm, Arm]
  eyes?: 'open' | 'shut' | 'happy'
}

// A block of a body, a leg at each corner, a stub of an arm on each side, two tall eyes: the banner's Clawd, stood up a little
// (a point taller, so 4 across to 3 up) so that it is not squat. A point is twice as tall as it is wide: 16 by 6 points.
const BODY_W = 16
const BODY_H = 6
const LEG = 2
/** How far down the body goes to lie or crouch on the ground, legs folded away. */
const GROUND = LEG
const ARM_W = 3
const ARM_H = 2
const ARM_REST = 3
const CHEER_STEPS = 3
const CHEER_FROM = 2
const EYE_W = 2
const EYE_H = 2
const EYE_IN = 2
const EYE_TOP = 1

const fill = (g: Grid, x: number, y: number, w: number, h: number, ch: string): void => {
  for (let j = 0; j < h; j++) {
    const line = g[y + j]
    for (let i = 0; i < w; i++) if (line !== undefined && x + i >= 0 && x + i < POINTS_W) line[x + i] = ch
  }
}

const stand = (s: Stance = {}): Grid => {
  const g: Grid = Array.from({ length: POINTS_H }, () => Array.from({ length: POINTS_W }, () => '.'))
  const x0 = (POINTS_W - BODY_W) / 2 + (s.dx ?? 0)
  // The last row of the body; the legs hang below it, to the ground at the bottom of the picture.
  const bottom = POINTS_H - 1 - LEG + (s.dy ?? 0)
  const height = BODY_H - (s.squash ?? 0)
  const top = bottom - height + 1
  fill(g, x0, top, BODY_W, height, 'o')

  const legAt = [0, 3, BODY_W - 5, BODY_W - 2]
  ;(s.legs ?? [LEG, LEG, LEG, LEG]).forEach((length, i) => fill(g, x0 + (legAt[i] ?? 0), bottom + 1, 2, length, 'o'))

  const arm = (x: number, at: Arm, isLeft: boolean): void => {
    if (at === 'cheer') {
      // Thrown up in a V: steps as thick as an arm, each two points further out and one up, so the arm slants at 45 degrees.
      for (let k = 0; k < CHEER_STEPS; k++) fill(g, x + (isLeft ? -2 : 2) * k, top + CHEER_FROM - k, ARM_W, ARM_H, 'o')
    } else fill(g, x, top + at, ARM_W, ARM_H, 'o')
  }
  const [left, right] = s.arms ?? [ARM_REST, ARM_REST]
  arm(x0 - ARM_W, left, true)
  arm(x0 + BODY_W, right, false)

  const y = top + EYE_TOP
  for (const x of [x0 + EYE_IN, x0 + BODY_W - EYE_IN - EYE_W]) {
    const eyes = s.eyes ?? 'open'
    if (eyes === 'open') fill(g, x, y, EYE_W, EYE_H, 'k')
    // Shut: a thin line, wider than the eye was.
    else if (eyes === 'shut') fill(g, x - 1, y + 1, EYE_W + 2, 1, 'k')
    else {
      // Happy: an arch.
      fill(g, x, y, EYE_W, 1, 'k')
      fill(g, x - 1, y + 1, 1, 1, 'k')
      fill(g, x + EYE_W, y + 1, 1, 1, 'k')
    }
  }
  return g
}

const frame = (stance: Stance, marks: readonly Mark[] = [], extra?: (g: Grid) => void): Frame => {
  const g = stand(stance)
  extra?.(g)
  return { points: g.map(line => line.join('')), marks }
}

const set = (g: Grid, x: number, y: number, ch: string): void => {
  const line = g[y]
  if (line !== undefined && x >= 0 && x < POINTS_W) line[x] = ch
}

// A gallop in place: a foot down on one side, the body up in the air, a foot down on the other, up again; the arms swing against
// the feet.
const GALLOP: readonly Stance[] = [
  { dx: -1, legs: [2, 1, 1, 2], arms: [4, 1] },
  { dy: -1, legs: [1, 1, 1, 1], arms: [3, 1] },
  { dx: 1, legs: [1, 2, 2, 1], arms: [1, 4] },
  { dy: -1, legs: [1, 1, 1, 1], arms: [1, 3] },
]

const run: readonly Frame[] = GALLOP.map(stance => frame(stance))

// A waddle: the body sways over the feet that are down.
const walk: readonly Frame[] = [
  frame({ dx: -1, legs: [2, 2, 1, 1], arms: [4, 1] }),
  frame({}),
  frame({ dx: 1, legs: [1, 1, 2, 2], arms: [1, 4] }),
  frame({}),
]

// The gallop, eyes screwed shut, with drops flying off to both sides: two at a time, on the way out and down.
const DROPS: readonly (readonly [number, number])[] = [
  [5, 1],
  [3, 2],
  [2, 4],
  [1, 6],
]
const sweat: readonly Frame[] = GALLOP.map((stance, i) =>
  frame({ ...stance, eyes: 'shut' }, [], g => {
    for (const k of [i, (i + 2) % DROPS.length]) {
      const [x, y] = DROPS[k] ?? [0, 0]
      for (const px of [x, POINTS_W - 1 - x]) {
        set(g, px, y, 's')
        set(g, px, y + 1, 's')
      }
    }
  }),
)

// Asleep: flattened to the ground, eyes shut, breathing in and out under z's that rise and fade. The middle picture is played twice.
const lie = (squash: number): Stance => ({
  dy: GROUND,
  squash,
  legs: [0, 0, 0, 0],
  arms: [BODY_H - squash - ARM_H, BODY_H - squash - ARM_H],
  eyes: 'shut',
})
const z = (col: number, row: number, ch: 'z' | 'Z'): Mark => ({ col, row, ch, color: 'z' })
const sleep: readonly Frame[] = [
  frame(lie(2), [z(13, 2, 'z')]),
  frame(lie(1), [z(13, 2, 'z'), z(14, 1, 'Z')]),
  frame(lie(1), [z(14, 1, 'Z')]),
  frame(lie(1), [z(13, 2, 'z'), z(14, 1, 'Z')]),
]

// Crouch, spring up with the arms thrown up in a V, hang there happy among the sparkles, come down, bounce, settle.
const spark = (col: number, row: number, ch: '+' | '*'): Mark => ({ col, row, ch, color: 'y' })
const jump: readonly Frame[] = [
  frame({ dy: GROUND, squash: 1, legs: [0, 0, 0, 0] }, [spark(0, 2, '+'), spark(15, 2, '+')]),
  frame({ dy: -1, arms: ['cheer', 'cheer'] }, [spark(0, 3, '+'), spark(15, 4, '*')]),
  frame({ dy: -2, legs: [1, 1, 1, 1], arms: ['cheer', 'cheer'], eyes: 'happy' }, [spark(0, 3, '*'), spark(15, 2, '+'), spark(13, 4, '*')]),
  frame({ dy: -2, legs: [1, 1, 1, 1], arms: ['cheer', 'cheer'], eyes: 'happy' }, [spark(1, 3, '+'), spark(14, 4, '*'), spark(0, 2, '+')]),
  frame({ arms: [0, 0], eyes: 'happy' }, [spark(0, 1, '+'), spark(15, 1, '*')]),
  frame({ dy: GROUND, squash: 1, legs: [0, 0, 0, 0], eyes: 'happy' }, [spark(1, 2, '*'), spark(14, 2, '+')]),
  frame({ arms: [2, 2] }, [spark(1, 1, '+')]),
  frame({ eyes: 'happy' }, [spark(14, 1, '+')]),
]

/** Every picture, by row, in the order it is played. */
export const FRAME_ROWS: Readonly<Record<Row, readonly Frame[]>> = { run, walk, sweat, sleep, jump }
