import { readFileSync } from 'node:fs'
import { decodePng } from './decode.ts'
import { png } from './png.ts'

export const ROWS = ['run', 'walk', 'sweat', 'sleep', 'jump'] as const
export type Row = (typeof ROWS)[number]
export const OUT_W = 256, OUT_H = 128

/** The pictures of each row that the cat plays: a sweat and a jump leave out the first, which has no drops, no sparkles, and so blinks; a sleep plays the last three. */
export const USED: Record<Row, readonly number[]> = { run: [0, 1, 2, 3, 4, 5], walk: [0, 1, 2, 3, 4, 5], sweat: [1, 2, 3, 4, 5], sleep: [3, 4, 5], jump: [1, 2, 3, 4, 5] }

type Comp = { id: number; area: number; x0: number; y0: number; x1: number; y1: number; sr: number; sg: number; sb: number; sat: number }
export type Frame = { row: Row; index: number; w: number; h: number; rgba: Uint8Array }

/** How alike two pictures are not: the alpha they differ by, summed. */
export const distance = (a: Frame, b: Frame): number => {
  let d = 0
  for (let i = 3; i < a.rgba.length; i += 4) d += Math.abs(a.rgba[i]! - b.rgba[i]!)
  return d / 255
}

/** The two pictures laid half over half: what the eye takes for the motion between them. */
export const blend = (a: Frame, b: Frame): Frame => {
  const rgba = new Uint8Array(a.rgba.length)
  for (let i = 0; i < a.rgba.length; i += 4) {
    const aa = a.rgba[i + 3]! / 255, ba = b.rgba[i + 3]! / 255
    const alpha = (aa + ba) / 2
    if (alpha > 0) for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((a.rgba[i + c]! * aa + b.rgba[i + c]! * ba) / (aa + ba))
    rgba[i + 3] = Math.round(alpha * 255)
  }
  return { row: a.row, index: a.index, w: a.w, h: a.h, rgba }
}

const permutations = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])))

/** A step between two pictures bigger than this gets a picture laid between them: more in a run, whose pictures are far apart. */
export const STEP_LIMITS: Record<Row, number> = { run: 1300, walk: 1600, sweat: 1500, sleep: 0, jump: 2200 }

/**
 * The order a row is played in, and the pictures laid between. A cycle (run, walk, sweat) is put in the order whose
 * neighbours are most alike, the way round the sheet runs; a jump keeps the sheet's order. Where two neighbours are still
 * far apart, the two laid half over half stand between them.
 */
export const playlist = (frames: Frame[], row: Row, limit = STEP_LIMITS[row]): Frame[] => {
  const mine = frames.filter(f => f.row === row).sort((a, b) => a.index - b.index)
  // Asleep: the last three, there and back, as the z's grow and shrink.
  if (row === 'sleep') return [mine[0]!, mine[1]!, mine[2]!, mine[1]!].map((f, index) => ({ ...f, index }))
  const n = mine.length
  const d = (i: number, j: number): number => distance(mine[i]!, mine[j]!)
  let order = [...Array(n).keys()]
  const isCycle = row !== 'jump'
  if (isCycle) {
    const cost = (o: number[]): number => o.reduce((sum, v, k) => sum + d(v, o[(k + 1) % n]!), 0)
    let best = order
    for (const p of permutations(order.slice(1))) {
      const o = [0, ...p]
      if (cost(o) < cost(best)) best = o
    }
    // The same cycle can be run either way round: the way the sheet runs.
    const forward = best.filter((v, k) => v < best[(k + 1) % n]!).length
    order = forward < n / 2 ? [0, ...best.slice(1).reverse()] : best
  }
  const out: Frame[] = []
  order.forEach((v, k) => {
    const next = order[k + 1] ?? (isCycle ? order[0]! : undefined)
    out.push(mine[v]!)
    if (next !== undefined && d(v, next) > limit) out.push(blend(mine[v]!, mine[next]!))
  })
  return out.map((f, index) => ({ ...f, index }))
}

export const playlists = (frames: Frame[]): Frame[] => ROWS.flatMap(row => playlist(frames, row))


/** Cuts the sheet into its pictures: each cat (and what floats about it: drops, z's, sparkles) on a clear ground. */
export const slice = (file: Uint8Array): Frame[] => {
  const { w, h, rgba } = decodePng(file)
  const at = (x: number, y: number) => { const o = (y * w + x) * 4; return [rgba[o]!, rgba[o + 1]!, rgba[o + 2]!] as const }
  const isDark = (x: number, y: number) => { const [r, g, b] = at(x, y); return Math.max(r, g, b) < 70 }
  // The ground: the dark that reaches the border. Dark inside a cat (an eye) is not reached, so it stays.
  const bg = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = y * w + x; if (bg[i] || !isDark(x, y)) return; bg[i] = 1; stack.push(i) }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (stack.length) { const i = stack.pop()!; const x = i % w, y = (i / w) | 0; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1) }
  // The ground seen through a gap (between the legs, in the curl of a tail) is not reached from the border, but it is the
  // ground's own grey, in a patch no eye is: it goes too.
  const isFlat = (x: number, y: number) => { const [r, g, b] = at(x, y); return Math.abs(r - 24) <= 5 && Math.abs(g - 24) <= 5 && Math.abs(b - 24) <= 5 }
  const seen = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i0 = y * w + x
    if (bg[i0] || seen[i0] || !isFlat(x, y)) continue
    const region: number[] = [i0]
    seen[i0] = 1
    for (let k = 0; k < region.length; k++) {
      const i = region[k]!; const px = i % w, py = (i / w) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = px + dx, ny = py + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (bg[j] || seen[j] || !isFlat(nx, ny)) continue
        seen[j] = 1; region.push(j)
      }
    }
    if (region.length >= 80) {
      for (const i of region) bg[i] = 1
      // and the dark that blurs into its edge, as along the outside
      const spread = [...region]
      for (let k = 0; k < spread.length; k++) {
        const i = spread[k]!; const px = i % w, py = (i / w) | 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = px + dx, ny = py + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (bg[j] || !isDark(nx, ny)) continue
          bg[j] = 1; spread.push(j)
        }
      }
    }
  }
  const label = new Int32Array(w * h).fill(-1)
  const comps: Comp[] = []
  for (let y0 = 0; y0 < h; y0++) for (let x0 = 0; x0 < w; x0++) {
    const i0 = y0 * w + x0
    if (bg[i0] || label[i0] >= 0) continue
    const c: Comp = { id: comps.length, area: 0, x0, y0, x1: x0, y1: y0, sr: 0, sg: 0, sb: 0, sat: 0 }
    const st = [i0]; label[i0] = c.id
    while (st.length) {
      const i = st.pop()!; const x = i % w, y = (i / w) | 0
      c.area++; c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y)
      const [r, g, b] = at(x, y); c.sr += r; c.sg += g; c.sb += b
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b); c.sat += mx === 0 ? 0 : (mx - mn) / mx
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (bg[j] || label[j] >= 0) continue
        label[j] = c.id; st.push(j)
      }
    }
    comps.push(c)
  }
  const cats = comps.filter(c => c.area > 5000)
  if (cats.length !== ROWS.length * 6) throw new Error(`expected ${ROWS.length * 6} cats, found ${cats.length}`)
  // Rows by height, then left to right.
  const sorted = [...cats].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))
  const rows = ROWS.map((_, r) => sorted.slice(r * 6, r * 6 + 6).sort((a, b) => a.x0 - b.x0))
  // What floats about a cat: coloured specks (not the white of the row labels), each to the nearest cat across, in its row.
  const rowTop = rows.map(r => Math.min(...r.map(c => c.y0)))
  const rowBottom = rows.map(r => Math.max(...r.map(c => c.y1)))
  const rowOf = (cy: number): number => {
    let best = 0, bestD = Infinity
    rows.forEach((_, r) => { const d = Math.abs(cy - (rowTop[r]! + rowBottom[r]!) / 2); if (d < bestD) { bestD = d; best = r } })
    return best
  }
  const members = new Map<number, Comp[]>()
  for (const c of cats) members.set(c.id, [c])
  for (const c of comps) {
    if (cats.includes(c) || c.area < 12) continue
    if (c.sat / c.area < 0.15) continue
    const r = rowOf((c.y0 + c.y1) / 2)
    const cx = (c.x0 + c.x1) / 2
    const near = rows[r]!.reduce((best, cat) => (Math.abs((cat.x0 + cat.x1) / 2 - cx) < Math.abs((best.x0 + best.x1) / 2 - cx) ? cat : best))
    members.get(near.id)!.push(c)
  }
  // The torso: what is left of the cat when the thin parts (legs, tail, whiskers of fur) are worn away. The cat is held
  // by it from frame to frame, so the body stays where it is as the legs go round, and does not slide.
  const torsoOf = (cat: Comp): readonly [number, number] => {
    const bw = cat.x1 - cat.x0 + 3, bh = cat.y1 - cat.y0 + 3
    let m = new Uint8Array(bw * bh)
    for (let y = cat.y0; y <= cat.y1; y++) for (let x = cat.x0; x <= cat.x1; x++) if (label[y * w + x] === cat.id) m[(y - cat.y0 + 1) * bw + (x - cat.x0 + 1)] = 1
    for (let pass = 0; pass < 9; pass++) {
      const next = new Uint8Array(bw * bh)
      for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x
        if (m[i] && m[i - 1] && m[i + 1] && m[i - bw] && m[i + bw]) next[i] = 1
      }
      m = next
    }
    let n = 0, sx = 0, sy = 0
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (m[y * bw + x]) { n++; sx += x + cat.x0 - 1; sy += y + cat.y0 - 1 }
    return n === 0 ? [(cat.x0 + cat.x1) / 2, (cat.y0 + cat.y1) / 2] : [sx / n, sy / n]
  }
  type Place = { cat: Comp; ids: Set<number>; ax: number; ay: number; bob: number; x0: number; x1: number; y0: number; y1: number }
  const places: Place[][] = rows.map((row, r) => {
    const held = ROWS[r] === 'sleep' ? row.map(c => [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2] as const) : row.map(torsoOf)
    const meanY = held.reduce((n, p) => n + p[1], 0) / held.length
    return row.map((cat, i) => {
      const ms = members.get(cat.id)!
      const [ax, ay] = held[i]!
      // Held in place, the cat's body does not rise and fall; only a jump (and a sleeper breathing) keeps its own height.
      const bob = ROWS[r] === 'jump' || ROWS[r] === 'sleep' ? ay - meanY : 0
      return { cat, ids: new Set(ms.map(m => m.id)), ax, ay, bob, x0: Math.min(...ms.map(m => m.x0)), x1: Math.max(...ms.map(m => m.x1)), y0: Math.min(...ms.map(m => m.y0)), y1: Math.max(...ms.map(m => m.y1)) }
    })
  })
  // What a row takes, measured from its anchors, decides the one scale and where each row's anchor stands in the picture.
  const span = (r: number) => {
    const ps = used(r)
    return {
      left: Math.max(...ps.map(p => p.ax - p.x0)), right: Math.max(...ps.map(p => p.x1 - p.ax)),
      up: Math.max(...ps.map(p => p.ay - p.bob - p.y0 + p.bob)), down: Math.max(...ps.map(p => p.y1 - p.ay)),
      bobUp: Math.max(...ps.map(p => -p.bob)), bobDown: Math.max(...ps.map(p => p.bob)),
    }
  }
  function used(r: number): Place[] {
    const keep = USED[ROWS[r]!]
    return places[r]!.filter((_, i) => keep.includes(i))
  }
  const MARGIN = 6
  const need = ROWS.map((_, r) => {
    const s = span(r)
    return { w: s.left + s.right + 1, h: s.up + s.down + s.bobUp + s.bobDown + 1 }
  })
  const scale = Math.min((OUT_W - 2 * MARGIN) / Math.max(...need.map(n => n.w)), (OUT_H - 2 * MARGIN) / Math.max(...need.map(n => n.h)))
  const frames: Frame[] = []
  places.forEach((rowPlaces, r) => {
    const s = span(r)
    // The row's anchor stands where its whole extent is centred.
    const acx = OUT_W / 2 + ((s.left - s.right) / 2) * scale
    const acy = OUT_H / 2 + (((s.up + s.bobUp) - (s.down + s.bobDown)) / 2) * scale
    rowPlaces.forEach((p, index) => {
      if (!USED[ROWS[r]!].includes(index)) return
      const ids = p.ids
      const flat = new Map(members.get(p.cat.id)!.map(m => [m.id, m.id === p.cat.id ? ([224, 138, 53] as const) : ([Math.round(m.sr / m.area), Math.round(m.sg / m.area), Math.round(m.sb / m.area)] as const)]))
      // The picture of one member's colour at a pixel: opaque inside, and at the rim as much as it differs from the ground.
      const sample = (x: number, y: number): [number, number, number, number] => {
        const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5)
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) return [0, 0, 0, 0]
        const id = label[yi * w + xi]!
        if (id < 0 || !ids.has(id)) return [0, 0, 0, 0]
        const rim = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]].some(([dx, dy]) => {
          const nx = xi + dx!, ny = yi + dy!
          return nx < 0 || ny < 0 || nx >= w || ny >= h || label[ny * w + nx]! < 0 || !ids.has(label[ny * w + nx]!)
        })
        const [r0, g0, b0] = at(xi, yi)
        if (!rim) return [r0, g0, b0, 1]
        const [fr, fg, fb] = flat.get(id)!
        const bgc = [24, 24, 24]
        const dr = fr - bgc[0]!, dg = fg - bgc[1]!, db = fb - bgc[2]!
        const a = Math.max(0, Math.min(1, ((r0 - bgc[0]!) * dr + (g0 - bgc[1]!) * dg + (b0 - bgc[2]!) * db) / (dr * dr + dg * dg + db * db)))
        return [fr, fg, fb, a]
      }
      const cy = acy + p.bob * scale
      const out = new Uint8Array(OUT_W * OUT_H * 4)
      const N = 3
      for (let oy = 0; oy < OUT_H; oy++) for (let ox = 0; ox < OUT_W; ox++) {
        let pr = 0, pg = 0, pb = 0, pa = 0
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const sx = p.ax + ((ox + (i + 0.5) / N) - acx) / scale
          const sy = p.ay + ((oy + (j + 0.5) / N) - cy) / scale
          const [sr, sg, sb, sa] = sample(sx, sy)
          pr += sr * sa; pg += sg * sa; pb += sb * sa; pa += sa
        }
        const o = (oy * OUT_W + ox) * 4
        if (pa > 0) { out[o] = Math.round(pr / pa); out[o + 1] = Math.round(pg / pa); out[o + 2] = Math.round(pb / pa) }
        out[o + 3] = Math.round((pa / (N * N)) * 255)
      }
      frames.push({ row: ROWS[r]!, index, w: OUT_W, h: OUT_H, rgba: out })
    })
  })
  return frames
}
