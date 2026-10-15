import { type Engine, describe, expect, test } from 'claude-code/testing'

import type { Facts } from '../types'

import { scaledPercent } from '../hooks/lib/advice'
import { CAT_COLS, CAT_ROWS, FRAMES, type Look, PICTURES, catCells, catPoints } from '../hooks/lib/cat'
import { MARK_COLORS, POINT_COLORS, type Row } from '../hooks/lib/clawd'
import { initialFacts } from '../hooks/lib/facts'
import { moodOf } from '../hooks/lib/mascot'
import { initialModes } from '../hooks/lib/modes'
import { computeOffers, pruneSeen } from '../hooks/lib/offers'
import { gaugeGrid } from '../hooks/lib/gauge'
import {
  DEFAULT_CACHE_TTL_MS,
  FAST_PERIOD_MS,
  JUMP_STEPS,
  SLOW_PERIOD_MS,
  catView,
  initialCat,
  isSweating,
  periodOf,
  speedOf,
  stageOf,
} from '../hooks/lib/pace'
import { QUADRANTS, TERMINAL_DEFAULT, packCells } from '../hooks/lib/raster'

import { answer, bandProps, decodeCells, engine, runStep, settingsPaneProps } from './kit'

const BASELINE = 27_000

/** Facts with a conversation `grown` tokens past an empty session of 27k, in a window of `window`. */
const grown = (tokens: number, over: Partial<Facts> = {}, window = 1_000_000): Facts => ({
  ...initialFacts,
  baselineTokens: BASELINE,
  contextTokens: BASELINE + tokens,
  contextWindow: window,
  contextPercent: Math.round(((BASELINE + tokens) / window) * 100),
  ...over,
})

describe('pace', () => {
  test('Clawd strolls until the conversation has grown a little, then runs faster the larger it gets, to its fastest where it starts to sweat', () => {
    // Nothing known, or nothing added to an empty session: the slowest stroll.
    expect(speedOf({ ...initialFacts })).toBe(0)
    expect(speedOf(grown(0))).toBe(0)

    const speeds = [10_000, 50_000, 100_000, 150_000, 153_000, 400_000].map(n => speedOf(grown(n)))
    expect(speeds[0]).toBe(0)
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b))
    // On the scale of 200k, 90% (the red of the frame) is 180k: 153k of conversation and the 27k of an empty session.
    expect(speeds[3]).toBeLessThan(1)
    expect(speeds[4]).toBe(1)
    // Past the sweat there is no faster.
    expect(speeds[5]).toBe(1)
  })

  test('it is at its fastest exactly when it sweats, in any window', () => {
    for (const window of [30_000, 50_000, 100_000, 200_000, 1_000_000]) {
      for (let tokens = BASELINE; tokens <= Math.min(window, 600_000); tokens += 1_000) {
        const f = grown(tokens - BASELINE, {}, window)
        expect(speedOf(f) === 1).toBe(isSweating(f))
      }
    }
  })

  test('in a window smaller than 200k the sweat comes when the window is nearly full', () => {
    const small = (n: number) => grown(n, {}, 100_000)
    // 90% of 100k, less the 27k of an empty session.
    expect(isSweating(small(62_000))).toBe(false)
    expect(isSweating(small(63_000))).toBe(true)
    expect(speedOf(small(63_000))).toBe(1)
    expect(speedOf(small(40_000))).toBeGreaterThan(0.3)
    // And never so small that it sweats the moment the session starts, while the window leaves it room to run up.
    expect(speedOf(grown(0, {}, 50_000))).toBe(0)
    expect(isSweating(grown(0, {}, 50_000))).toBe(false)
  })

  test('frames come quicker as the speed rises, from a stroll to a sprint', () => {
    expect(periodOf(0)).toBe(SLOW_PERIOD_MS)
    expect(periodOf(1)).toBe(FAST_PERIOD_MS)
    expect(periodOf(0.5)).toBeLessThan(periodOf(0.25))
    expect(periodOf(-3)).toBe(SLOW_PERIOD_MS)
    expect(periodOf(9)).toBe(FAST_PERIOD_MS)
    expect(['walk', 'trot', 'run', 'sprint']).toEqual([0.1, 0.35, 0.65, 0.95].map(stageOf))
  })

  test('the view: asleep before the first word, running by the size, sweating at the top, curled up for good when the cache is gone', () => {
    // No request yet: nothing is cached. Asleep, breathing.
    const asleep = catView(grown(5_000), initialCat)
    expect(asleep.look.pose).toBe('sleep')
    expect(asleep.isResting).toBe(false)
    expect(asleep.phrase).toContain('眠って')
    // Even a big conversation: it was picked up, not talked to.
    expect(catView(grown(120_000), initialCat).look.pose).toBe('sleep')

    // A small conversation does not sleep; it strolls, at the slowest.
    const small = catView(grown(5_000), { ...initialCat, idleMs: 0 })
    expect(small.look).toEqual({ pose: 'run', frame: 0, isSweating: false, step: 0, isWalking: true })
    expect(small.periodMs).toBe(SLOW_PERIOD_MS)

    const running = catView(grown(120_000), { ...initialCat, idleMs: 0 })
    expect(running.look).toEqual({ pose: 'run', frame: 0, isSweating: false, step: 0, isWalking: false })
    expect(running.periodMs).toBeLessThan(SLOW_PERIOD_MS)
    expect(catView(grown(120_000), { ...initialCat, idleMs: 0, steps: 5 }).look.frame).toBe(1)

    // The top of the speed is 90% of the window: a 200k window gets there with a conversation of 153k.
    const full = catView(grown(160_000, {}, 200_000), { ...initialCat, idleMs: 0 })
    expect(full.look.isSweating).toBe(true)
    expect(full.periodMs).toBe(FAST_PERIOD_MS)
    expect(full.phrase).toContain('汗')
    expect(catView(grown(120_000), { ...initialCat, idleMs: 0 }).look.isSweating).toBe(false)

    // The cache's life over: it sleeps and nothing need run until the person is back.
    const gone = catView(grown(120_000), { ...initialCat, idleMs: DEFAULT_CACHE_TTL_MS })
    expect(gone.look.pose).toBe('sleep')
    expect(gone.isResting).toBe(true)
    expect(gone.phrase).toContain('キャッシュが切れ')
    expect(catView(grown(120_000), { ...initialCat, idleMs: DEFAULT_CACHE_TTL_MS - 1 }).isResting).toBe(false)
    // A cache that lives an hour (a subscription's) is not gone at five minutes.
    expect(catView(grown(120_000), { ...initialCat, ttlMs: 60 * 60_000, idleMs: DEFAULT_CACHE_TTL_MS }).isResting).toBe(false)
    expect(catView(grown(120_000), { ...initialCat, ttlMs: 60 * 60_000, idleMs: 60 * 60_000 }).isResting).toBe(true)
  })

  test('a jump, and the demonstrations of the pane, take over from what the facts say', () => {
    const f = grown(120_000)
    const jump = catView(f, { ...initialCat, jumpLeft: JUMP_STEPS })
    expect(jump.look.pose).toBe('jump')
    expect(jump.isResting).toBe(false)
    // Even a Clawd asleep for the night jumps.
    expect(catView(f, { ...initialCat, idleMs: DEFAULT_CACHE_TTL_MS, jumpLeft: 3 }).look.pose).toBe('jump')

    expect(catView(f, { ...initialCat, demo: 'sprint' }).periodMs).toBeLessThan(periodOf(0.8))
    expect(catView(f, { ...initialCat, demo: 'sprint' }).look.isSweating).toBe(false)
    expect(catView(f, { ...initialCat, demo: 'walk' }).periodMs).toBeGreaterThan(200)
    expect(catView(f, { ...initialCat, demo: 'sweat' }).look.isSweating).toBe(true)
    expect(catView(f, { ...initialCat, demo: 'sweat' }).periodMs).toBe(FAST_PERIOD_MS)
    expect(catView(f, { ...initialCat, demo: 'sleep' }).look.pose).toBe('sleep')
    // A demonstration is not the idle Clawd: it keeps running while it lasts.
    expect(catView(f, { ...initialCat, demo: 'run', idleMs: DEFAULT_CACHE_TTL_MS }).isResting).toBe(false)
  })
})

describe('one scale for the cat, the colours and the suggestions', () => {
  const at = (tokens: number, window: number): Facts => ({
    ...initialFacts,
    contextTokens: tokens,
    contextWindow: window,
    contextPercent: Math.round((tokens / window) * 100),
  })

  test('in a window of a million, 140k is a heavy conversation, as it would be in a window of 200k', () => {
    expect(scaledPercent(at(100_000, 1_000_000))).toBe(50)
    expect(scaledPercent(at(140_000, 1_000_000))).toBe(70)
    expect(scaledPercent(at(180_000, 1_000_000))).toBe(90)
    // The scale stops at full; the gauge goes on showing the real share.
    expect(scaledPercent(at(600_000, 1_000_000))).toBe(100)
    expect(at(140_000, 1_000_000).contextPercent).toBe(14)
  })

  test('up to 200k the window is the scale, so nothing changes there; and with nothing known the engine’s percent stands', () => {
    expect(scaledPercent(at(140_000, 200_000))).toBe(70)
    expect(scaledPercent(at(40_000, 100_000))).toBe(40)
    expect(scaledPercent({ ...initialFacts, contextPercent: 33 })).toBe(33)
    expect(scaledPercent(initialFacts)).toBe(null)
  })

  test('the suggestion, the cat’s sweat and the mood all come at the same point', () => {
    const quiet = at(130_000, 1_000_000)
    const heavy = at(145_000, 1_000_000)
    const full = at(185_000, 1_000_000)
    expect(computeOffers({ facts: quiet, modes: initialModes, modelRow: null }).some(o => o.kind === 'compact')).toBe(false)
    expect(computeOffers({ facts: heavy, modes: initialModes, modelRow: null }).find(o => o.kind === 'compact')?.id).toBe('compact-70')
    expect(computeOffers({ facts: full, modes: initialModes, modelRow: null }).find(o => o.kind === 'compact')?.id).toBe('compact-90')
    expect(moodOf(quiet, null, false)).toBe('good')
    expect(moodOf(heavy, null, false)).toBe('heavy')
    expect(moodOf(full, null, false)).toBe('full')
    expect(isSweating(heavy)).toBe(false)
    expect(isSweating(full)).toBe(true)
    // ...and so does the top of the speed.
    expect(speedOf(heavy)).toBeLessThan(1)
    expect(speedOf(full)).toBe(1)
  })

  test('a heavy spell is judged on the same scale: it ends when the conversation falls below it', () => {
    expect(pruneSeen(['compact-70', 'compact-90', 'effort'], at(145_000, 1_000_000))).toEqual(['compact-70', 'effort'])
    expect(pruneSeen(['compact-70', 'compact-90', 'effort'], at(100_000, 1_000_000))).toEqual(['effort'])
  })
})

/** Every picture of every row, as the look that chooses it. */
const LOOKS: Record<Row, Look[]> = {
  run: Array.from({ length: PICTURES.run }, (_, step) => ({ pose: 'run', frame: step, isSweating: false, step, isWalking: false })),
  walk: Array.from({ length: PICTURES.walk }, (_, step) => ({ pose: 'run', frame: step, isSweating: false, step, isWalking: true })),
  sweat: Array.from({ length: PICTURES.sweat }, (_, step) => ({ pose: 'run', frame: step, isSweating: true, step })),
  sleep: Array.from({ length: PICTURES.sleep }, (_, step) => ({ pose: 'sleep', frame: step, isSweating: false, step })),
  jump: Array.from({ length: PICTURES.jump }, (_, step) => ({ pose: 'jump', frame: step, isSweating: false, step })),
}
const ROW_NAMES = Object.keys(LOOKS) as Row[]
const looks = (): Look[] => Object.values(LOOKS).flat()

describe('Clawd’s picture', () => {
  const FUR = POINT_COLORS.o
  const EYE = POINT_COLORS.k
  const SWEAT = POINT_COLORS.s
  const SIGNS = ['z', 'Z', '+', '*']
  const COLOR: Record<string, number> = { '.': TERMINAL_DEFAULT, o: FUR, k: EYE, s: SWEAT }

  /** The points of one cell of the grid: letters, `o` body, `k` eye, `s` sweat, `.` nothing. */
  const cellsOf = (look: Look) => decodeCells(catCells(look))
  const pointsIn = (look: Look, index: number) => {
    const rows = catPoints(look)
    const col = index % CAT_COLS
    const row = Math.floor(index / CAT_COLS)
    return [0, 1].flatMap(dy => [0, 1].map(dx => rows[row * 2 + dy]?.[col * 2 + dx] ?? '.'))
  }
  const signsOf = (look: Look) => cellsOf(look).flatMap((c, i) => (c.ch === 'z' || c.ch === 'Z' ? [`${c.ch}${i}`] : []))

  test('five rows of pictures: a run, a walk, a sweat, a sleep and a jump', () => {
    expect(PICTURES).toEqual({ run: 4, walk: 4, sweat: 4, sleep: 4, jump: 8 })
    // The cells and the pictures share one count, so a frame never means two things.
    expect(FRAMES).toEqual({ run: PICTURES.run, sleep: PICTURES.sleep, jump: PICTURES.jump })
  })

  test('every look fills the grid, in glyphs and colours a Raster accepts', () => {
    for (const look of looks()) {
      const cells = cellsOf(look)
      expect(cells.length).toBe(CAT_COLS * CAT_ROWS)
      for (const cell of cells) {
        // One printable glyph of one column, from the basic plane: a quarter block, or a sign.
        expect([...QUADRANTS, ...SIGNS] as string[]).toContain(cell.ch)
        expect(cell.ch.codePointAt(0) ?? 0).toBeLessThan(0x10000)
        // 0xRRGGBB, or the terminal's own.
        for (const color of [cell.fg, cell.bg]) expect(color === TERMINAL_DEFAULT || (color >= 0 && color <= 0xffffff)).toBe(true)
        // A cell with nothing in it leaves the terminal's own background showing.
        if (cell.ch === ' ') expect(cell.bg).toBe(TERMINAL_DEFAULT)
      }
    }
  })

  test('a point is as wide as the grid says, on every row of every frame', () => {
    for (const look of looks()) {
      const rows = catPoints(look)
      expect(rows.length).toBe(CAT_ROWS * 2)
      for (const row of rows) expect(row.length).toBe(CAT_COLS * 2)
    }
  })

  test('no picture is the one before it, so there is something to animate, and no row borrows another’s', () => {
    for (const row of ROW_NAMES) {
      const cells = LOOKS[row].map(catCells)
      cells.forEach((c, i) => expect(c).not.toBe(cells[(i + 1) % cells.length]))
      // Only the middle picture of a walk or a sleep is played twice (there and back).
      expect(new Set(cells).size).toBe(row === 'walk' || row === 'sleep' ? cells.length - 1 : cells.length)
    }
    const groups = ROW_NAMES.map(row => new Set(LOOKS[row].map(catCells)))
    groups.forEach((a, i) => groups.forEach((b, j) => i !== j && expect([...a].some(c => b.has(c))).toBe(false)))
    // A frame past the end of the cycle is the cycle again, and a look with no step uses its frame.
    expect(catCells({ pose: 'run', frame: PICTURES.run, isSweating: false })).toBe(catCells({ pose: 'run', frame: 0, isSweating: false }))
    expect(catCells({ pose: 'run', frame: 2, isSweating: false, step: 2 })).toBe(catCells({ pose: 'run', frame: 2, isSweating: false }))
    // The cells tell a walk and a sweat from a run, as the pictures do.
    expect(catCells({ pose: 'run', frame: 0, isSweating: false, isWalking: true })).not.toBe(catCells({ pose: 'run', frame: 0, isSweating: false }))
    expect(catCells({ pose: 'run', frame: 0, isSweating: true })).not.toBe(catCells({ pose: 'run', frame: 0, isSweating: false }))
  })

  test('it is one orange body: fur, dark eyes and the little marks, no other colour', () => {
    for (const look of looks()) {
      const colors = new Set(cellsOf(look).flatMap(c => (c.ch === ' ' ? [] : [c.fg, c.bg])).filter(c => c !== TERMINAL_DEFAULT))
      expect(colors.has(FUR)).toBe(true)
      for (const color of colors) expect([FUR, EYE, SWEAT, MARK_COLORS.z, MARK_COLORS.y]).toContain(color)
      // And it is a body’s size, not a speck.
      expect(catPoints(look).join('').split('o').length - 1).toBeGreaterThan(60)
    }
  })

  test('the whole outline changes from one running frame to the next, not only the feet', () => {
    const outline = (look: Look) => catPoints(look).map(row => [...row].map(ch => (ch === '.' ? ' ' : 'x')).join(''))
    const run = LOOKS.run.map(outline)
    run.forEach((a, i) => {
      const b = run[(i + 1) % run.length] ?? []
      const changed = a.join('').split('').filter((ch, k) => ch !== b.join('')[k]).length
      expect(changed).toBeGreaterThanOrEqual(12)
    })
    // The body rises and falls: the top row of it is not always the same.
    const tops = LOOKS.run.map(look => catPoints(look).findIndex(row => row.includes('o')))
    expect(new Set(tops).size).toBeGreaterThan(1)
  })

  test('Clawd has two eyes, in every frame, set in the body: eight dark points, never at its edge', () => {
    for (const look of looks()) {
      const rows = catPoints(look)
      expect(rows.join('').split('k').length - 1).toBe(8)
      rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch !== 'k') return
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) expect(rows[y + dy]?.[x + dx] ?? '.').not.toBe('.')
        }),
      )
      // An eye is dark in the cells it is in: on the body's colour, or a whole cell of its own.
      expect(cellsOf(look).some(c => c.fg === EYE)).toBe(true)
    }
  })

  test('asleep it lies on the ground with its eyes shut, a thin line, under z’s that come and go', () => {
    for (const look of LOOKS.sleep) {
      const rows = catPoints(look)
      // Shut: all the dark points are in one row, and it is low in the picture.
      expect(rows.flatMap((row, y) => (row.includes('k') ? [y] : [])).length).toBe(1)
      expect(rows.slice(0, 3).join('')).not.toContain('o')
      expect(signsOf(look).length).toBeGreaterThan(0)
    }
    const signs = LOOKS.sleep.map(l => signsOf(l).join())
    expect(new Set(signs).size).toBe(3)
    expect(signs[1]).toBe(signs[3])
  })

  test('a sweat shows on every sweating frame and on no other, and a sparkle on every leaping one', () => {
    for (const look of LOOKS.sweat) {
      expect(catPoints(look).join('')).toContain('s')
      expect(cellsOf(look).some(c => c.fg === SWEAT)).toBe(true)
    }
    for (const row of ROW_NAMES.filter(r => r !== 'sweat')) {
      for (const look of LOOKS[row]) expect(cellsOf(look).some(c => c.fg === SWEAT)).toBe(false)
    }
    for (const look of LOOKS.jump) expect(cellsOf(look).some(c => c.ch === '+' || c.ch === '*')).toBe(true)
  })

  test('each cell draws exactly the four points it stands for, and a mark never shares a cell with Clawd', () => {
    for (const look of looks()) {
      cellsOf(look).forEach((cell, i) => {
        const points = pointsIn(look, i)
        if (SIGNS.includes(cell.ch)) {
          // A mark: its cell holds no body.
          expect(points.every(p => p === '.')).toBe(true)
          return
        }
        // A quarter of the glyph is the foreground, the others the background: that is what the points say, with no point lost.
        const bits = QUADRANTS.indexOf(cell.ch as (typeof QUADRANTS)[number])
        const drawn = points.map((_, k) => ((bits >> k) & 1) === 1 ? cell.fg : cell.bg)
        expect(drawn).toEqual(points.map(p => COLOR[p]))
      })
    }
  })

  test('cells pack as little-endian u32 triplets in standard padded base64', () => {
    const packed = packCells([{ ch: '█', fg: 0xff8800, bg: TERMINAL_DEFAULT }])
    expect(packed).toBe('iCUAAACI/wAAAAAB')
    expect(decodeCells(packed)).toEqual([{ ch: '█', fg: 0xff8800, bg: TERMINAL_DEFAULT }])
    // Every cell is 12 bytes.
    expect(catCells({ pose: 'run', frame: 0, isSweating: false }).length).toBe(Math.ceil((CAT_COLS * CAT_ROWS * 12) / 3) * 4)
  })
})

describe('the gauge', () => {
  const filled = (percent: number, columns = 10) => gaugeGrid(percent, columns).map(c => c.ch).join('')

  test('it fills in eighths of a cell and a thin line remains where it is empty', () => {
    expect(filled(0)).toBe('▁▁▁▁▁▁▁▁▁▁')
    expect(filled(100)).toBe('██████████')
    expect(filled(50)).toBe('█████▁▁▁▁▁')
    // Five and a half cells of ten: a half block follows five whole ones.
    expect(filled(55)).toBe('█████▌▁▁▁▁')
    expect(filled(-20)).toBe(filled(0))
    expect(filled(240)).toBe(filled(100))
  })

  test('it goes from green to red along its length, so the danger is a place on it', () => {
    const cells = gaugeGrid(100, 10)
    const channel = (color: number, shift: number) => (color >> shift) & 255
    expect(channel(cells[0]?.fg ?? 0, 8)).toBeGreaterThan(channel(cells[0]?.fg ?? 0, 16))
    expect(channel(cells[9]?.fg ?? 0, 16)).toBeGreaterThan(channel(cells[9]?.fg ?? 0, 8))
  })
})

const measureTokens = (tokens: number, window = 1_000_000) =>
  ({
    context: { window, tokens, percent: Math.round((tokens / window) * 100) },
    rateLimits: [] as never[],
    changed: ['context'] as ['context'],
  })

const cellsOf = (look: Look): string => catCells(look)

/** The person says a word: the prompt cache is warm, and Clawd is awake. */
const speak = ($: Engine): Promise<unknown> => $.prompt.submit({ text: 'hello' } as never)

test('the band hands the cat its place and repaints it frame by frame, there and nowhere else', async ($, on) => {
  const calls = engine(on)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)

  // Nothing is painted until a frame is due, and then at the band's own id and the cat's key.
  expect(calls.blits.length).toBe(0)
  await calls.clock.advance(1500)
  expect(calls.blits.length).toBeGreaterThan(3)
  for (const blit of calls.blits) {
    expect(blit.requestId).toBe('band')
    expect(blit.key).toBe('cat')
    expect(decodeCells(blit.cells).length).toBe(CAT_COLS * CAT_ROWS)
  }
  // The frames run through the cycle in order.
  const frames = calls.blits.slice(0, 4).map(b => b.cells)
  expect(frames).toEqual(LOOKS.run.map(catCells))
  await ui.unmount()
})

test('the larger the conversation, the quicker the frames', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await speak($)

  await $.session.measure(measureTokens(BASELINE + 40_000))
  await calls.clock.advance(3000)
  const stroll = calls.blits.length

  calls.blits.length = 0
  await $.session.measure(measureTokens(BASELINE + 200_000))
  await calls.clock.advance(3000)
  const sprint = calls.blits.length

  expect(stroll).toBeGreaterThan(5)
  expect(sprint).toBeGreaterThan(stroll * 2)
})

test('before the first word Clawd sleeps: the picture is Clawd lying down, not the running one', async ($, on) => {
  const calls = engine(on, { conversationTokens: 1_000 })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 3_000))
  await calls.clock.advance(3000)

  const asleep = LOOKS.sleep.map(catCells)
  expect(calls.blits.length).toBeGreaterThan(2)
  for (const blit of calls.blits) expect(asleep).toContain(blit.cells)
})

test('a small conversation does not sleep: it strolls, at the slowest, once there is a cache to keep warm', async ($, on) => {
  const calls = engine(on, { conversationTokens: 1_000 })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 3_000))
  await speak($)
  calls.blits.length = 0
  await calls.clock.advance(3000)

  const strolling = LOOKS.walk.map(catCells)
  expect(calls.blits.length).toBeGreaterThan(8)
  for (const blit of calls.blits) expect(strolling).toContain(blit.cells)
})

test('when the prompt cache is gone Clawd curls up for good; the next word wakes it', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)

  // A minute short of the cache's five: Clawd is running.
  const sleeping = cellsOf({ pose: 'sleep', frame: 0, isSweating: false, step: 1 })
  await calls.clock.advance(DEFAULT_CACHE_TTL_MS - 60_000)
  expect(calls.blits.length).toBeGreaterThan(100)
  expect(calls.blits.some(b => b.cells === sleeping)).toBe(false)

  await calls.clock.advance(65_000)
  // The resting picture is the second of the row: breathing in, with both z's.
  expect(calls.blits.at(-1)?.cells).toBe(sleeping)

  // Nothing runs on any more: not a frame in an hour.
  const painted = calls.blits.length
  await calls.clock.advance(60 * 60_000)
  expect(calls.blits.length).toBe(painted)

  // A redraw of the band (the figures changed) is not the person's word: Clawd stays asleep.
  await $.session.measure(measureTokens(BASELINE + 121_000))
  await calls.clock.advance(5_000)
  expect(calls.blits.length).toBe(painted)

  await $.prompt.submit({ text: 'hello again' } as never)
  await calls.clock.advance(500)
  expect(calls.blits.length).toBeGreaterThan(painted)
  expect(calls.blits.at(-1)?.cells).not.toBe(sleeping)
})

test('a request answered starts the cache’s life over, so a long turn does not put Clawd to sleep', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)

  const sleeping = cellsOf({ pose: 'sleep', frame: 0, isSweating: false, step: 1 })
  await calls.clock.advance(4 * 60_000)
  await runStep($)
  // Four more minutes, eight in all since the word: the request four minutes ago kept the cache.
  await calls.clock.advance(4 * 60_000)
  expect(calls.blits.some(b => b.cells === sleeping)).toBe(false)

  await calls.clock.advance(2 * 60_000)
  expect(calls.blits.at(-1)?.cells).toBe(sleeping)
})

test('on a subscription the cache lives an hour, so Clawd sleeps then and not at five minutes', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  // A small conversation, at the slowest stroll, so that an hour of frames is not too many to run.
  await $.session.measure({ ...measureTokens(BASELINE + 3_000), rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] as never })
  await speak($)

  const sleeping = cellsOf({ pose: 'sleep', frame: 0, isSweating: false, step: 1 })
  await calls.clock.advance(DEFAULT_CACHE_TTL_MS + 60_000)
  expect(calls.blits.some(b => b.cells === sleeping)).toBe(false)

  // The timer runs a frame at a time: the clock is advanced in steps it can follow.
  for (let minutes = 6; minutes < 60; minutes += 6) await calls.clock.advance(6 * 60_000)
  await calls.clock.advance(60_000)
  expect(calls.blits.at(-1)?.cells).toBe(sleeping)
})

test('a mod loaded again in a running session finds Clawd awake while the last turn is within the cache’s life, and asleep after', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000, model: 'm' }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)
  await calls.clock.advance(2 * 60_000)

  // A start over: the module's own memory of the cache's age is gone, the facts are not. The band is drawn again as it is on a load.
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measureTokens(BASELINE + 120_500))
  calls.blits.length = 0
  await calls.clock.advance(1_000)
  const sleeping = LOOKS.sleep.map(catCells)
  expect(calls.blits.length).toBeGreaterThan(2)
  expect(calls.blits.every(b => !sleeping.includes(b.cells))).toBe(true)

  // Three more minutes: the turn ended five minutes ago, whatever the start over forgot.
  await calls.clock.advance(3 * 60_000)
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measureTokens(BASELINE + 121_000))
  await calls.clock.advance(1_000)
  expect(calls.blits.at(-1)?.cells).toBe(cellsOf({ pose: 'sleep', frame: 0, isSweating: false, step: 1 }))
})

const wakeBy = (name: string, act: ($: Engine) => Promise<unknown>): void => {
  test(`a Clawd asleep for good is woken by ${name}`, async ($, on) => {
    const calls = engine(on)
    on('tool.call', () => ({ result: { type: 'text' }, text: 'x', isReadOnly: true, ref: 1 }) as never)
    await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.session.measure(measureTokens(BASELINE + 120_000))
    await speak($)
    await calls.clock.advance(DEFAULT_CACHE_TTL_MS + 5_000)
    const painted = calls.blits.length

    await act($)
    await calls.clock.advance(1_000)
    expect(calls.blits.length).toBeGreaterThan(painted)
  })
}

wakeBy('a prompt', $ => $.prompt.submit({ text: 'hello again' } as never))
wakeBy('a turn starting', $ => $.turn.start({ text: 'go', turnId: 't1' } as never))
wakeBy('a tool call', $ => $.tool.call({ tool: 'Read', tool_use_id: 'tu_1', file_path: '/a.ts' } as never))
wakeBy('a turn ending', $ =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never),
)

test('a repaint the engine refuses stops the timer, and the next draw of the band starts it again', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)

  calls.isBlitRefused = true
  await calls.clock.advance(2000)
  expect(calls.blits.length).toBe(0)

  // The engine takes the refusal back, but nothing draws the band: no timer is running to notice.
  calls.isBlitRefused = false
  await calls.clock.advance(2000)
  expect(calls.blits.length).toBe(0)

  // The band is back on screen: its draw hands the cat its place again.
  await $.session.measure(measureTokens(BASELINE + 121_000))
  await calls.clock.advance(1000)
  expect(calls.blits.length).toBeGreaterThan(3)
})

test('no timer runs where the band draws no cat', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'desktop' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await calls.clock.advance(5000)
  expect(calls.blits.length).toBe(0)
})

test('a compaction makes the cat jump, and then it runs at the new, slower pace', async ($, on) => {
  const calls = engine(on, { compacted: { tokensBefore: 160_000, tokensAfter: 45_000 } })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await calls.clock.advance(500)
  calls.blits.length = 0

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await calls.clock.advance(2000)
  const jumps = LOOKS.jump.map(catCells)
  const first = calls.blits.slice(0, JUMP_STEPS)
  expect(first.length).toBe(JUMP_STEPS)
  for (const blit of first) expect(jumps).toContain(blit.cells)
  // Then back to running, 45k being lighter than 120k.
  expect(calls.blits.slice(JUMP_STEPS).every(b => !jumps.includes(b.cells))).toBe(true)
})

test('a compaction the person accepts from the dialog makes the cat jump, though the mod’s own call passes through none of its hooks', async ($, on) => {
  const calls = engine(on, { compacted: { tokensBefore: 160_000, tokensAfter: 45_000 } })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(750_000))
  await calls.clock.advance(300)
  calls.blits.length = 0

  await answer($, 'accept')
  await calls.clock.advance(300)
  expect(calls.compacts).toBe(1)
  expect(calls.blits.some(b => b.cells === cellsOf({ pose: 'jump', frame: 0, isSweating: false }))).toBe(true)
})

test('/clear makes the cat jump too', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await calls.clock.advance(500)
  calls.blits.length = 0

  await $.session.end({ reason: 'clear' } as never)
  await calls.clock.advance(300)
  expect(calls.blits.some(b => b.cells === cellsOf({ pose: 'jump', frame: 0, isSweating: false }))).toBe(true)
})

test('a cat dozing in its slow frames still jumps at once when the conversation is cleared', async ($, on) => {
  const calls = engine(on, { conversationTokens: 1_000 })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 3_000))
  await calls.clock.advance(100)
  calls.blits.length = 0

  await $.session.end({ reason: 'clear' } as never)
  await calls.clock.advance(150)
  expect(calls.blits.some(b => b.cells === cellsOf({ pose: 'jump', frame: 0, isSweating: false }))).toBe(true)
})

test('the pane can show every pose, whatever the conversation is like, and then the cat goes back to the facts', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', key: 'cat-sprint' })).toBeDefined()

  await pane.press({ key: 'cat-sprint' })
  await calls.clock.advance(500)
  const sprint = LOOKS.run.map(catCells)
  expect(calls.blits.length).toBeGreaterThan(4)
  expect(calls.blits.every(b => sprint.includes(b.cells))).toBe(true)

  calls.blits.length = 0
  await pane.press({ key: 'cat-sweat' })
  await calls.clock.advance(300)
  expect(calls.blits.some(b => LOOKS.sweat.some(look => b.cells === catCells(look)))).toBe(true)

  calls.blits.length = 0
  await pane.press({ key: 'cat-jump' })
  await calls.clock.advance(200)
  expect(calls.blits.some(b => b.cells === cellsOf({ pose: 'jump', frame: 0, isSweating: false }))).toBe(true)

  // After the demonstration Clawd goes back to what the facts say: an empty conversation, a stroll, with a cache warm from the pane.
  await calls.clock.advance(30_000)
  calls.blits.length = 0
  await calls.clock.advance(2_000)
  const strolling = LOOKS.walk.map(catCells)
  expect(calls.blits.length).toBeGreaterThan(0)
  expect(calls.blits.every(b => strolling.includes(b.cells))).toBe(true)
})

test('the words beside the cat follow what it is doing, though the band is drawn again only when that changes', async ($, on) => {
  const calls = engine(on)
  const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  await calls.clock.advance(50)
  expect(await band.find({ type: 'Text', text: /ぐっすり眠って/ })).toBeDefined()

  await pane.press({ key: 'cat-sprint' })
  await calls.clock.advance(300)
  expect(await band.find({ type: 'Text', text: /全力で走って/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /ぐっすり眠って/ })).toBeUndefined()

  await pane.press({ key: 'cat-sweat' })
  await calls.clock.advance(300)
  expect(await band.find({ type: 'Text', text: /汗だく/ })).toBeDefined()

  // The demonstration over, the words go back to what the facts say: nothing grown yet, a stroll.
  await calls.clock.advance(30_000)
  expect(await band.find({ type: 'Text', text: /のんびり歩いて/ })).toBeDefined()

  // And once the cache is gone, Clawd is said to be asleep for that.
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await calls.clock.advance(DEFAULT_CACHE_TTL_MS + 5_000)
  expect(await band.find({ type: 'Text', text: /キャッシュが切れた/ })).toBeDefined()
})

test('with "Reduce motion" on the cat stands still: a picture for each state, no timer, no jump, no demonstration', async ($, on) => {
  const calls = engine(on, { config: { reduceMotion: true }, compacted: { tokensBefore: 160_000, tokensAfter: 45_000 } })
  const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)
  await calls.clock.advance(5_000)
  expect(calls.blits.length).toBe(0)

  // There is still a cat, and it is the running one, in its first frame.
  const still = cellsOf({ pose: 'run', frame: 0, isSweating: false })
  expect((await band.find({ type: 'Raster', key: 'cat' }))?.props.cells).toBe(still)

  // A compaction does not leave it jumping for good.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await calls.clock.advance(2_000)
  expect(calls.blits.length).toBe(0)
  expect((await band.find({ type: 'Raster', key: 'cat' }))?.props.cells).not.toBe(cellsOf({ pose: 'jump', frame: 0, isSweating: false }))

  // The pane has no demonstration to give.
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', key: 'cat-sprint' })).toBeUndefined()
})

/** The person flips the /config row, as the menu hands it to `config.set`. */
const reduceMotion = (value: boolean) =>
  ({ key: 'reduceMotion', value, previous: !value, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } }) as const

test('turning "Reduce motion" on stops a running cat, and off sets it going again', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)
  await calls.clock.advance(1_000)
  expect(calls.blits.length).toBeGreaterThan(0)

  await $.config.set(reduceMotion(true))
  calls.blits.length = 0
  await calls.clock.advance(5_000)
  expect(calls.blits.length).toBe(0)

  await $.config.set(reduceMotion(false))
  await calls.clock.advance(1_000)
  expect(calls.blits.length).toBeGreaterThan(2)
})

test('a build with no "Reduce motion" row leaves the cat running', async ($, on) => {
  const calls = engine(on, { config: { reduceMotion: 'absent' } })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)
  await calls.clock.advance(1_000)
  expect(calls.blits.length).toBeGreaterThan(2)
})

test('the pane offers the demonstration only once the band is showing a cat', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', key: 'cat-sprint' })).toBeUndefined()
})

test('the first response measures what an empty session holds, so Clawd’s speed is counted from there', async ($, on) => {
  const calls = engine(on, { conversationTokens: 3_000 })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await speak($)
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000, model: 'm' }

  // 30k in the window and 3k of it conversation: an empty session holds 27k, so 46k is a conversation grown 19k, short of the 20k
  // where the run begins to speed up: a stroll.
  await $.session.measure(measureTokens(30_000))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)
  expect(calls.usageAsked).toBeGreaterThan(0)
  calls.blits.length = 0
  await $.session.measure(measureTokens(46_000))
  await calls.clock.advance(1000)
  expect(calls.blits.length).toBeGreaterThan(0)
  expect(calls.blits.every(b => LOOKS.walk.map(catCells).includes(b.cells))).toBe(true)

  // Grown well past it, Clawd gallops.
  calls.blits.length = 0
  await $.session.measure(measureTokens(130_000))
  await calls.clock.advance(1000)
  expect(calls.blits.some(b => LOOKS.run.some(look => b.cells === catCells(look)))).toBe(true)
})

test('a session that ends stops the timer', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await speak($)
  await calls.clock.advance(500)
  expect(calls.blits.length).toBeGreaterThan(0)

  await $.session.end({ reason: 'exit' } as never)
  const painted = calls.blits.length
  await calls.clock.advance(5000)
  expect(calls.blits.length).toBe(painted)
})
