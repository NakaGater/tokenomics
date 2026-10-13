import { inflateSync } from 'node:zlib'
/** A non-interlaced 8-bit PNG (RGB or RGBA) as RGBA pixels. */
export const decodePng = (file: Uint8Array): { w: number; h: number; rgba: Uint8Array } => {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  let o = 8, w = 0, h = 0, depth = 0, ctype = 0
  const idat: Uint8Array[] = []
  while (o < file.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(...file.subarray(o + 4, o + 8))
    const data = file.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = file[o + 16]!; ctype = file[o + 17]!; if (file[o + 20] !== 0) throw new Error('interlaced') }
    if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error(`unsupported png: depth ${depth} type ${ctype}`)
  const bpp = ctype === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = new Uint8Array(w * h * 4)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!
    const line = new Uint8Array(raw.buffer, raw.byteOffset + y * (stride + 1) + 1, stride).slice()
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c })()
      line[i] = (line[i]! + pred) & 255
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4
      out[d] = line[s]!; out[d + 1] = line[s + 1]!; out[d + 2] = line[s + 2]!; out[d + 3] = bpp === 4 ? line[s + 3]! : 255
    }
    prev = line
  }
  return { w, h, rgba: out }
}
