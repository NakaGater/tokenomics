import { type Engine, describe, expect, test } from 'claude-code/testing'

import type { Facts } from '../types'

import { scaledPercent } from '../hooks/lib/advice'
import { CAT_COLS, CAT_ROWS, FRAMES, type Look, type Pose, catCells, catPoints } from '../hooks/lib/cat'
import { initialFacts } from '../hooks/lib/facts'
import { moodOf } from '../hooks/lib/mascot'
import { initialModes } from '../hooks/lib/modes'
import { computeOffers, pruneSeen } from '../hooks/lib/offers'
import { gaugeGrid } from '../hooks/lib/gauge'
import {
  FAST_PERIOD_MS,
  IDLE_SLEEP_MS,
  JUMP_STEPS,
  SLOW_PERIOD_MS,
  WAKE_TOKENS,
  catView,
  fullTokensOf,
  growthOf,
  initialCat,
  isAsleep,
  isSweating,
  periodOf,
  speedOf,
  stageOf,
} from '../hooks/lib/pace'
import { QUADRANTS, TERMINAL_DEFAULT, packCells } from '../hooks/lib/raster'

import { answer, bandProps, decodeCells, engine, settingsPaneProps } from './kit'

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
  test('the cat counts what the conversation has added to an empty session, not the 27k every session starts with', () => {
    expect(growthOf(grown(0))).toBe(0)
    expect(growthOf(grown(50_000))).toBe(50_000)
    // Before a response has measured anything the cat sleeps; before the baseline is known a typical one is assumed.
    expect(growthOf({ ...initialFacts })).toBe(0)
    expect(growthOf({ ...initialFacts, contextTokens: 45_000 })).toBe(20_000)
    expect(growthOf(grown(0, { contextTokens: 10 }))).toBe(0)
  })

  test('it sleeps until the conversation has grown a little, then runs faster the larger it gets, to a sprint at 200k', () => {
    expect(isAsleep(grown(WAKE_TOKENS - 1))).toBe(true)
    expect(isAsleep(grown(WAKE_TOKENS))).toBe(false)

    const speeds = [20_000, 50_000, 100_000, 150_000, 200_000, 400_000].map(n => speedOf(grown(n)))
    expect(speeds[0]).toBe(0)
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b))
    expect(speeds[4]).toBe(1)
    // Past a sprint there is no faster.
    expect(speeds[5]).toBe(1)
  })

  test('in a window smaller than 200k the sprint comes when the window is nearly full', () => {
    const small = (n: number) => grown(n, {}, 100_000)
    expect(fullTokensOf(small(0))).toBe(73_000)
    expect(speedOf(small(73_000))).toBe(1)
    expect(speedOf(small(40_000))).toBeGreaterThan(0.3)
    // And never so small that the cat is at full speed the moment it wakes.
    expect(fullTokensOf(grown(0, {}, 30_000))).toBeGreaterThan(WAKE_TOKENS)
  })

  test('frames come quicker as the speed rises, from a stroll to a sprint', () => {
    expect(periodOf(0)).toBe(SLOW_PERIOD_MS)
    expect(periodOf(1)).toBe(FAST_PERIOD_MS)
    expect(periodOf(0.5)).toBeLessThan(periodOf(0.25))
    expect(periodOf(-3)).toBe(SLOW_PERIOD_MS)
    expect(periodOf(9)).toBe(FAST_PERIOD_MS)
    expect(['walk', 'trot', 'run', 'sprint']).toEqual([0.1, 0.35, 0.65, 0.95].map(stageOf))
  })

  test('the view: asleep when empty, running when grown, sweating near full, curled up for good when idle', () => {
    const asleep = catView(grown(5_000), initialCat)
    expect(asleep.look.pose).toBe('sleep')
    expect(asleep.isResting).toBe(false)
    expect(asleep.phrase).toContain('眠って')

    const running = catView(grown(120_000), initialCat)
    expect(running.look).toEqual({ pose: 'run', frame: 0, isSweating: false, step: 0, isWalking: false })
    expect(running.periodMs).toBeLessThan(SLOW_PERIOD_MS)
    expect(catView(grown(120_000), { ...initialCat, steps: 5 }).look.frame).toBe(1)

    // Near full is 90% of the window, whatever the speed: a 200k window gets there with a conversation of 160k.
    const full = catView(grown(160_000, {}, 200_000), initialCat)
    expect(full.look.isSweating).toBe(true)
    expect(full.phrase).toContain('汗')
    expect(catView(grown(120_000), initialCat).look.isSweating).toBe(false)

    // Five quiet minutes: it sleeps and nothing need run until the person is back.
    const idle = catView(grown(120_000), { ...initialCat, idleMs: IDLE_SLEEP_MS })
    expect(idle.look.pose).toBe('sleep')
    expect(idle.isResting).toBe(true)
    expect(catView(grown(120_000), { ...initialCat, idleMs: IDLE_SLEEP_MS - 1 }).isResting).toBe(false)
  })

  test('a jump, and the demonstrations of the pane, take over from what the facts say', () => {
    const f = grown(120_000)
    const jump = catView(f, { ...initialCat, jumpLeft: JUMP_STEPS })
    expect(jump.look.pose).toBe('jump')
    expect(jump.isResting).toBe(false)
    // Even a cat asleep for the night jumps.
    expect(catView(f, { ...initialCat, idleMs: IDLE_SLEEP_MS, jumpLeft: 3 }).look.pose).toBe('jump')

    expect(catView(f, { ...initialCat, demo: 'sprint' }).periodMs).toBe(FAST_PERIOD_MS)
    expect(catView(f, { ...initialCat, demo: 'walk' }).periodMs).toBeGreaterThan(200)
    expect(catView(f, { ...initialCat, demo: 'sweat' }).look.isSweating).toBe(true)
    expect(catView(f, { ...initialCat, demo: 'sleep' }).look.pose).toBe('sleep')
    // A demonstration is not the idle cat: it keeps running while it lasts.
    expect(catView(f, { ...initialCat, demo: 'run', idleMs: IDLE_SLEEP_MS }).isResting).toBe(false)
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
  })

  test('a heavy spell is judged on the same scale: it ends when the conversation falls below it', () => {
    expect(pruneSeen(['compact-70', 'compact-90', 'worker'], at(145_000, 1_000_000))).toEqual(['compact-70', 'worker'])
    expect(pruneSeen(['compact-70', 'compact-90', 'worker'], at(100_000, 1_000_000))).toEqual(['worker'])
  })
})

const POSES: Pose[] = ['run', 'sleep', 'jump']
const looks = (): Look[] =>
  POSES.flatMap(pose =>
    Array.from({ length: FRAMES[pose] }, (_, frame) => [false, true].map(isSweating => ({ pose, frame, isSweating }))).flat(),
  )

describe('the cat’s picture', () => {
  const FUR = 0xe8913a
  const EYE = 0x2a1b14
  const SWEAT = 0x7fd0ff
  const SIGNS = ['z', 'Z', '+', '*']

  /** The cat as filled points (`o` and `k`) and the cell each cell of the grid draws, row by row. */
  const pointsOf = (look: Look) => catPoints(look).map(row => [...row].map(ch => ch !== '.'))
  const cellsOf = (look: Look) => decodeCells(catCells(look))
  const pointsIn = (look: Look, index: number) => {
    const rows = catPoints(look)
    const col = index % CAT_COLS
    const row = Math.floor(index / CAT_COLS)
    return [0, 1].flatMap(dy => [0, 1].map(dx => rows[row * 2 + dy]?.[col * 2 + dx] ?? '.'))
  }

  test('every look fills the grid, in glyphs and colours a Raster accepts', () => {
    for (const look of looks()) {
      const cells = cellsOf(look)
      expect(cells.length).toBe(CAT_COLS * CAT_ROWS)
      for (const cell of cells) {
        // One printable glyph of one column, from the basic plane: a quarter block, the thin bar of a shut eye, or a sign.
        expect([...QUADRANTS, '▂', ...SIGNS] as string[]).toContain(cell.ch)
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

  test('the frames of a pose differ, so there is something to animate; so does a sweat from none', () => {
    for (const pose of POSES) {
      const seen = new Set(Array.from({ length: FRAMES[pose] }, (_, frame) => catCells({ pose, frame, isSweating: false })))
      expect(seen.size).toBe(FRAMES[pose])
    }
    expect(catCells({ pose: 'run', frame: 0, isSweating: true })).not.toBe(catCells({ pose: 'run', frame: 0, isSweating: false }))
    // A frame past the end of the cycle is the cycle again.
    expect(catCells({ pose: 'run', frame: 4, isSweating: false })).toBe(catCells({ pose: 'run', frame: 0, isSweating: false }))
  })

  test('it is one silhouette in orange: fur, a dark eye and the little marks, no other colour', () => {
    for (const look of looks()) {
      const colors = new Set(cellsOf(look).flatMap(c => (c.ch === ' ' ? [] : [c.fg, c.bg])).filter(c => c !== TERMINAL_DEFAULT))
      expect(colors.has(FUR)).toBe(true)
      for (const color of colors) expect([FUR, EYE, SWEAT, 0xa8b4ff, 0xffe066]).toContain(color)
    }
    // And it is a cat’s size, not a speck.
    for (let frame = 0; frame < FRAMES.run; frame++) {
      const filled = pointsOf({ pose: 'run', frame, isSweating: false }).flat().filter(Boolean).length
      expect(filled).toBeGreaterThan(70)
    }
  })

  test('the whole outline changes from one running frame to the next, not only the feet', () => {
    const run = (frame: number) => pointsOf({ pose: 'run', frame, isSweating: false })
    for (let frame = 0; frame < FRAMES.run; frame++) {
      const a = run(frame)
      const b = run(frame + 1)
      const changed = a.flat().filter((on, i) => on !== b.flat()[i]).length
      expect(changed).toBeGreaterThanOrEqual(24)
      // The top of the back moves too (a row above the legs differs), so the body rises and falls.
      expect(a.slice(0, 5).map(r => r.join('')).join('|')).not.toBe(b.slice(0, 5).map(r => r.join('')).join('|'))
    }
  })

  test('the cat has a head: broad ears at the top right and a dark eye, in every running and leaping frame', () => {
    for (const look of looks().filter(l => l.pose !== 'sleep')) {
      expect(cellsOf(look).some(c => c.fg === EYE && c.bg === FUR)).toBe(true)
    }
    // The ears are the top of the head: something is drawn in the top rows at the right-hand end, with a gap between two ears.
    const rows = catPoints({ pose: 'run', frame: 2, isSweating: false })
    const ears = rows[0] ?? ''
    expect(ears.slice(-14).split('').filter(ch => ch !== '.').length).toBe(2)
    expect(rows[1]?.slice(-14)).toMatch(/o+\.o+/)
  })

  test('asleep it has a shut eye, a thin bar on the face, and the head is told from the back by a dip', () => {
    for (let frame = 0; frame < FRAMES.sleep; frame++) {
      const look: Look = { pose: 'sleep', frame, isSweating: false }
      expect(cellsOf(look).filter(c => c.ch === '▂' && c.fg === EYE && c.bg === FUR).length).toBe(1)
      // Two ears stand above the loaf.
      expect(catPoints(look)[3]?.match(/o+/g)?.length).toBeGreaterThanOrEqual(2)
    }
    // The z’s are letters, and they drift between the two frames.
    const signs = (frame: number) => cellsOf({ pose: 'sleep', frame, isSweating: false }).flatMap((c, i) => (c.ch === 'z' || c.ch === 'Z' ? [`${c.ch}${i}`] : []))
    expect(signs(0).length).toBe(2)
    expect(signs(1).length).toBe(2)
    expect(signs(0).join()).not.toBe(signs(1).join())
  })

  test('a sweat shows on every running frame, and a sparkle on every leaping one', () => {
    for (let frame = 0; frame < FRAMES.run; frame++) {
      expect(cellsOf({ pose: 'run', frame, isSweating: true }).some(c => c.fg === SWEAT)).toBe(true)
      expect(cellsOf({ pose: 'run', frame, isSweating: false }).some(c => c.fg === SWEAT)).toBe(false)
    }
    for (let frame = 0; frame < FRAMES.jump; frame++) {
      expect(cellsOf({ pose: 'jump', frame, isSweating: false }).some(c => c.ch === '+' || c.ch === '*')).toBe(true)
    }
  })

  test('a mark never shares a cell with the cat, and a cell of two colours is all cat: nothing is painted over empty points', () => {
    for (const look of looks()) {
      cellsOf(look).forEach((cell, i) => {
        const points = pointsIn(look, i)
        if (cell.ch === ' ') return
        if (cell.bg === FUR) {
          // The eye on a face, or the shut eye: every other point of the cell is fur.
          expect(points.every(p => p !== '.')).toBe(true)
        } else if (cell.fg === FUR) {
          // Plain fur: the glyph is exactly the fur points.
          const bits = points.reduce((n, p, k) => (p === 'o' ? n | (1 << k) : n), 0)
          expect(cell.ch).toBe(QUADRANTS[bits])
        } else {
          // A mark: its cell holds no cat.
          expect(points.every(p => p === '.')).toBe(true)
        }
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

test('the band hands the cat its place and repaints it frame by frame, there and nowhere else', async ($, on) => {
  const calls = engine(on)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))

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
  expect(frames).toEqual([0, 1, 2, 3].map(frame => cellsOf({ pose: 'run', frame, isSweating: false })))
  await ui.unmount()
})

test('the larger the conversation, the quicker the frames', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })

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

test('an empty conversation sleeps: the picture is the curled cat, two frames, not the running one', async ($, on) => {
  const calls = engine(on, { conversationTokens: 1_000 })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 3_000))
  await calls.clock.advance(3000)

  const asleep = [0, 1].map(frame => cellsOf({ pose: 'sleep', frame, isSweating: false }))
  expect(calls.blits.length).toBeGreaterThan(2)
  for (const blit of calls.blits) expect(asleep).toContain(blit.cells)
})

test('five quiet minutes and the cat curls up for good; the next word wakes it', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))

  await calls.clock.advance(IDLE_SLEEP_MS + 5_000)
  const sleeping = cellsOf({ pose: 'sleep', frame: 0, isSweating: false })
  expect(calls.blits.at(-1)?.cells).toBe(sleeping)

  // Nothing runs on any more: not a frame in an hour.
  const painted = calls.blits.length
  await calls.clock.advance(60 * 60_000)
  expect(calls.blits.length).toBe(painted)

  // A redraw of the band (the figures changed) is not the person's word: the cat stays asleep.
  await $.session.measure(measureTokens(BASELINE + 121_000))
  await calls.clock.advance(5_000)
  expect(calls.blits.length).toBe(painted)

  await $.prompt.submit({ text: 'hello again' } as never)
  await calls.clock.advance(500)
  expect(calls.blits.length).toBeGreaterThan(painted)
  expect(calls.blits.at(-1)?.cells).not.toBe(sleeping)
})

const wakeBy = (name: string, act: ($: Engine) => Promise<unknown>): void => {
  test(`a cat asleep for good is woken by ${name}`, async ($, on) => {
    const calls = engine(on)
    on('tool.call', () => ({ result: { type: 'text' }, text: 'x', isReadOnly: true, ref: 1 }) as never)
    await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.session.measure(measureTokens(BASELINE + 120_000))
    await calls.clock.advance(IDLE_SLEEP_MS + 5_000)
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
  const jumps = [0, 1, 2, 3].map(frame => cellsOf({ pose: 'jump', frame, isSweating: false }))
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
  const sprint = [0, 1, 2, 3].map(frame => cellsOf({ pose: 'run', frame, isSweating: false }))
  expect(calls.blits.length).toBeGreaterThan(4)
  expect(calls.blits.every(b => sprint.includes(b.cells))).toBe(true)

  calls.blits.length = 0
  await pane.press({ key: 'cat-sweat' })
  await calls.clock.advance(300)
  expect(calls.blits.some(b => [0, 1, 2, 3].some(frame => b.cells === cellsOf({ pose: 'run', frame, isSweating: true })))).toBe(true)

  calls.blits.length = 0
  await pane.press({ key: 'cat-jump' })
  await calls.clock.advance(200)
  expect(calls.blits.some(b => b.cells === cellsOf({ pose: 'jump', frame: 0, isSweating: false }))).toBe(true)

  // After the demonstration the empty conversation sleeps again.
  await calls.clock.advance(30_000)
  calls.blits.length = 0
  await calls.clock.advance(2_000)
  const asleep = [0, 1].map(frame => cellsOf({ pose: 'sleep', frame, isSweating: false }))
  expect(calls.blits.length).toBeGreaterThan(0)
  expect(calls.blits.every(b => asleep.includes(b.cells))).toBe(true)
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

  // The demonstration over, the words go back to what the facts say.
  await calls.clock.advance(30_000)
  expect(await band.find({ type: 'Text', text: /ぐっすり眠って/ })).toBeDefined()

  // And a quiet cat is said to be resting.
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await calls.clock.advance(IDLE_SLEEP_MS + 5_000)
  expect(await band.find({ type: 'Text', text: /お休み中/ })).toBeDefined()
})

test('with "Reduce motion" on the cat stands still: a picture for each state, no timer, no jump, no demonstration', async ($, on) => {
  const calls = engine(on, { config: { reduceMotion: true }, compacted: { tokensBefore: 160_000, tokensAfter: 45_000 } })
  const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.start({ cwd: '/work' } as never)
  await $.session.measure(measureTokens(BASELINE + 120_000))
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
  await calls.clock.advance(1_000)
  expect(calls.blits.length).toBeGreaterThan(2)
})

test('the pane offers the demonstration only once the band is showing a cat', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', key: 'cat-sprint' })).toBeUndefined()
})

test('the first response measures what an empty session holds, so the cat is counted from there', async ($, on) => {
  const calls = engine(on, { conversationTokens: 3_000 })
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000, model: 'm' }

  // 30k in the window and 3k of it conversation: an empty session holds 27k, so 47k is a grown 20k: awake.
  await $.session.measure(measureTokens(30_000))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)
  expect(calls.usageAsked).toBeGreaterThan(0)
  calls.blits.length = 0
  await $.session.measure(measureTokens(46_000))
  await calls.clock.advance(1000)
  expect(calls.blits.every(b => [0, 1].map(frame => cellsOf({ pose: 'sleep', frame, isSweating: false })).includes(b.cells))).toBe(true)

  calls.blits.length = 0
  await $.session.measure(measureTokens(47_500))
  await calls.clock.advance(1000)
  expect(calls.blits.some(b => [0, 1, 2, 3].some(frame => b.cells === cellsOf({ pose: 'run', frame, isSweating: false })))).toBe(true)
})

test('a session that ends stops the timer', async ($, on) => {
  const calls = engine(on)
  await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await $.session.measure(measureTokens(BASELINE + 120_000))
  await calls.clock.advance(500)
  expect(calls.blits.length).toBeGreaterThan(0)

  await $.session.end({ reason: 'exit' } as never)
  const painted = calls.blits.length
  await calls.clock.advance(5000)
  expect(calls.blits.length).toBe(painted)
})
