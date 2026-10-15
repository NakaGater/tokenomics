import { describe, expect, test } from 'claude-code/testing'

import { CAT_COLS, CAT_ROWS, FRAMES, type Look, PICTURES, catPng } from '../hooks/lib/cat'
import { bandProps, engine, fromBase64 } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const BASELINE = 27_000

const measureTokens = (tokens: number, window = 1_000_000) =>
  ({
    context: { window, tokens, percent: Math.round((tokens / window) * 100) },
    rateLimits: [] as never[],
    changed: ['context'] as ['context'],
  })

const KITTY = { ORCA_IMAGE_PROTOCOL: 'kitty' }

/** Every picture, as the looks that choose them. */
const looks = (): Look[] => [
  ...Array.from({ length: PICTURES.run }, (_, step) => ({ pose: 'run' as const, frame: step % FRAMES.run, isSweating: false, step, isWalking: false })),
  ...Array.from({ length: PICTURES.walk }, (_, step) => ({ pose: 'run' as const, frame: step % FRAMES.run, isSweating: false, step, isWalking: true })),
  ...Array.from({ length: PICTURES.sweat }, (_, step) => ({ pose: 'run' as const, frame: step % FRAMES.run, isSweating: true, step })),
  ...Array.from({ length: PICTURES.sleep }, (_, step) => ({ pose: 'sleep' as const, frame: step % FRAMES.sleep, isSweating: false, step })),
  ...Array.from({ length: PICTURES.jump }, (_, step) => ({ pose: 'jump' as const, frame: step % FRAMES.jump, isSweating: false, step })),
]

describe('Clawd’s pictures', () => {
  test('every look has a picture: a PNG of 256 x 160 pixels, wider than tall as the 16 x 5 cells are', () => {
    for (const look of looks()) {
      const bytes = fromBase64(catPng(look))
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      const header = new DataView(bytes.buffer, bytes.byteOffset)
      expect(header.getUint32(16)).toBe(256)
      expect(header.getUint32(20)).toBe(160)
      // 8-bit RGBA: the picture has a clear ground.
      expect(bytes[24]).toBe(8)
      expect(bytes[25]).toBe(6)
    }
    expect(256 / 160).toBe(CAT_COLS / CAT_ROWS / 2)
  })

  test('the pictures of a cycle differ, and a run, a walk, a sweat, a sleep and a jump are told apart', () => {
    const of = (look: Look) => catPng(look)
    const sizes = PICTURES
    for (const pose of ['run', 'walk', 'sweat', 'jump'] as const) {
      const cycle = looks().filter(l =>
        pose === 'jump' ? l.pose === 'jump' : l.pose === 'run' && (pose === 'sweat' ? l.isSweating : !l.isSweating && (l.isWalking === true) === (pose === 'walk')),
      )
      // A walk passes through the same picture on its way each way: that one is played twice.
      expect(new Set(cycle.map(of)).size).toBe(pose === 'walk' ? sizes[pose] - 1 : sizes[pose])
    }
    // Asleep the z's grow and shrink: the middle picture is played twice.
    expect(new Set(looks().filter(l => l.pose === 'sleep').map(of)).size).toBe(PICTURES.sleep - 1)
    // Five groups, none a picture of another's.
    const groups = [
      looks().filter(l => l.pose === 'run' && !l.isSweating && l.isWalking === false),
      looks().filter(l => l.pose === 'run' && !l.isSweating && l.isWalking === true),
      looks().filter(l => l.pose === 'run' && l.isSweating),
      looks().filter(l => l.pose === 'sleep'),
      looks().filter(l => l.pose === 'jump'),
    ].map(g => new Set(g.map(of)))
    groups.forEach((a, i) => groups.forEach((b, j) => i !== j && expect([...a].some(p => b.has(p))).toBe(false)))
  })

  test('the pictures go round: a step past the end is the start again, and a look with no step uses its frame', () => {
    expect(catPng({ pose: 'run', frame: 0, isSweating: false, step: PICTURES.run })).toBe(catPng({ pose: 'run', frame: 0, isSweating: false, step: 0 }))
    expect(catPng({ pose: 'sleep', frame: 0, isSweating: false, step: PICTURES.sleep })).toBe(catPng({ pose: 'sleep', frame: 0, isSweating: false, step: 0 }))
    expect(catPng({ pose: 'run', frame: 2, isSweating: false })).toBe(catPng({ pose: 'run', frame: 2, isSweating: false, step: 2 }))
  })
})

describe('the cat as a picture in the band', () => {
  test('where the terminal says it draws pictures, the card shows Clawd as an Image, 16 x 5 cells, and keeps the gauge in cells', async ($, on) => {
    engine(on, { env: KITTY })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

    const picture = await ui.find({ type: 'Image', key: 'cat' })
    expect(picture).toBeDefined()
    expect(picture?.props.columns).toBe(CAT_COLS)
    expect(picture?.props.rows).toBe(CAT_ROWS)
    expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeUndefined()
    expect(await ui.find({ type: 'Raster', key: 'gauge' })).toBeDefined()
    await ui.unmount()
  })

  test('a mod reloaded in a running session never sees session.start, and still learns what the terminal says', async ($, on) => {
    engine(on, { env: KITTY })
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

    expect(await ui.find({ type: 'Image', key: 'cat' })).toBeDefined()
    await ui.unmount()
  })

  const inCells: [string, Record<string, string>][] = [
    ['nothing is said of pictures', {}],
    ['it is tmux, which passes none', { ...KITTY, TMUX: '/tmp/tmux-1/default,1,0' }],
    ['it is told not to', { ...KITTY, TOKENOMICS_CAT_IMAGE: '0' }],
    ['it is the Terminal app', { TERM_PROGRAM: 'Apple_Terminal' }],
  ]
  for (const [why, env] of inCells) {
    test(`the cat is in cells where ${why}`, async ($, on) => {
      engine(on, { env })
      await $.session.start(START)
      const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
      expect(await ui.find({ type: 'Image' })).toBeUndefined()
      expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeDefined()
      await ui.unmount()
    })
  }

  const tried: [string, Record<string, string>][] = [
    ['kitty’s window id is set', { KITTY_WINDOW_ID: '3' }],
    ['Ghostty’s resources are named', { GHOSTTY_RESOURCES_DIR: '/x' }],
    ['the program is ghostty', { TERM_PROGRAM: 'ghostty' }],
    ['the program is kitty', { TERM_PROGRAM: 'kitty' }],
    ['it is asked for', { TOKENOMICS_CAT_IMAGE: '1' }],
  ]
  for (const [why, env] of tried) {
    test(`a picture is tried where ${why}`, async ($, on) => {
      engine(on, { env })
      await $.session.start(START)
      const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
      expect(await ui.find({ type: 'Image', key: 'cat' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('the frames are blits of a picture, no redraw, and go through the pictures in order', async ($, on) => {
    const calls = engine(on, { env: KITTY })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.session.measure(measureTokens(BASELINE + 150_000))
    await $.prompt.submit({ text: 'hello' } as never)
    calls.blits.length = 0
    await calls.clock.advance(1500)

    expect(calls.blits.length).toBeGreaterThan(PICTURES.run)
    for (const blit of calls.blits) {
      expect(blit.requestId).toBe('band')
      expect(blit.key).toBe('cat')
      expect(blit.cells).toBe('')
      expect(blit.png).toBeDefined()
    }
    // A gallop, picture after picture: this is a run, not a walk.
    const first = calls.blits.filter(b => b.png !== undefined).slice(0, PICTURES.run).map(b => b.png)
    expect(first).toEqual(Array.from({ length: PICTURES.run }, (_, step) => catPng({ pose: 'run', frame: step % FRAMES.run, isSweating: false, step, isWalking: false })))
    await ui.unmount()
  })

  test('a slow Clawd walks and a sweating one is Clawd in a sweat', async ($, on) => {
    const calls = engine(on, { env: KITTY })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.prompt.submit({ text: 'hello' } as never)

    await $.session.measure(measureTokens(BASELINE + 40_000))
    calls.blits.length = 0
    await calls.clock.advance(1000)
    const strolling = calls.blits.map(b => b.png)
    const walk = looks().filter(l => l.isWalking === true).map(l => catPng(l))
    expect(strolling.length).toBeGreaterThan(2)
    expect(strolling.every(p => walk.includes(p ?? ''))).toBe(true)

    await $.session.measure(measureTokens(BASELINE + 190_000, 200_000))
    calls.blits.length = 0
    await calls.clock.advance(800)
    const sweat = looks().filter(l => l.isSweating).map(l => catPng(l))
    expect(calls.blits.length).toBeGreaterThan(3)
    expect(calls.blits.every(b => sweat.includes(b.png ?? ''))).toBe(true)
    await ui.unmount()
  })

  test('a picture the terminal refuses is the answer: the band is drawn again with the cat in cells, and stays so', async ($, on) => {
    const calls = engine(on, { env: KITTY })
    calls.isImageRefused = true
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.session.measure(measureTokens(BASELINE + 120_000))
    await $.prompt.submit({ text: 'hello' } as never)
    await calls.clock.advance(1500)

    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeDefined()
    // The cells are painted from then on, and the picture is not asked for again.
    expect(calls.blits.length).toBeGreaterThan(2)
    expect(calls.blits.every(b => b.png === undefined && b.cells !== '')).toBe(true)
    await ui.unmount()
  })

  test('with reduced motion nothing is repainted, yet the terminal is still asked once, so a blank box does not stay', async ($, on) => {
    const calls = engine(on, { env: KITTY, config: { reduceMotion: true } })
    calls.isImageRefused = true
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    expect(await ui.find({ type: 'Image', key: 'cat' })).toBeDefined()

    await calls.clock.advance(400)
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeDefined()
    await ui.unmount()
  })

  test('with reduced motion and a terminal that draws pictures, the picture stays and is asked for once', async ($, on) => {
    const calls = engine(on, { env: KITTY, config: { reduceMotion: true } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await calls.clock.advance(1000)

    expect(await ui.find({ type: 'Image', key: 'cat' })).toBeDefined()
    // Asked once, with the picture on show, and never repainted: the cat stands still.
    expect(calls.blits.length).toBe(1)
    expect(calls.blits[0]?.png).toBeDefined()
    await ui.unmount()
  })

  test('where the terminal took a picture once, a refused repaint later means the band is off screen, not that pictures are out', async ($, on) => {
    const calls = engine(on, { env: KITTY })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await $.session.measure(measureTokens(BASELINE + 120_000))
    await calls.clock.advance(600)
    expect(calls.blits.some(b => b.png !== undefined)).toBe(true)

    calls.isBlitRefused = true
    await calls.clock.advance(600)
    calls.isBlitRefused = false
    await ui.redraw()
    expect(await ui.find({ type: 'Image', key: 'cat' })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop and the other surfaces, which have no cells to draw in, show no picture either', async ($, on) => {
    engine(on, { env: KITTY })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'desktop' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  })
})
