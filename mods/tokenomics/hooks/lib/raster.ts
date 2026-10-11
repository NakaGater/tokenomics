/** The terminal's own foreground or background: bit 24 alone, as `RasterProps` spells it. */
export const TERMINAL_DEFAULT = 0x01000000

/** One terminal cell of a `Raster`: a printable width-1 glyph and its two colors (`0xRRGGBB`, or the default). */
export type Cell = { ch: string; fg: number; bg: number }

export const BLANK: Cell = { ch: ' ', fg: TERMINAL_DEFAULT, bg: TERMINAL_DEFAULT }

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64; a module has no Buffer, and `toBase64` is not everywhere. */
const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }
  return out
}

/** `RasterProps.cells`: every cell row-major as little-endian u32 `[codePoint, foreground, background]`. */
export const packCells = (cells: readonly Cell[]): string => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((cell, i) => {
    words[i * 3] = cell.ch.codePointAt(0) ?? 0x20
    words[i * 3 + 1] = cell.fg
    words[i * 3 + 2] = cell.bg
  })
  return base64(new Uint8Array(words.buffer))
}

/** The quarter blocks, by which of the four quarters are filled (bit 1 top left, 2 top right, 4 bottom left, 8 bottom right). */
export const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const

/** The left eighths of a cell, 1 to 8 filled. */
export const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const

export const rgb = (r: number, g: number, b: number): number =>
  (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)

/** A color a given way from `from` to `to` (0 to 1). */
export const mix = (from: number, to: number, t: number): number => {
  const k = Math.max(0, Math.min(1, t))
  const channel = (shift: number): number => {
    const a = (from >> shift) & 255
    const b = (to >> shift) & 255
    return a + (b - a) * k
  }
  return rgb(channel(16), channel(8), channel(0))
}
