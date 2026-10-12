import type { TurnTokens } from '../../types'

/** 950 -> "950", 3200 -> "3.2k", 48000 -> "48k", 1.2M -> "1.2M". */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${trimZero((n / 1_000_000).toFixed(1))}M`
}

const trimZero = (s: string): string => s.replace(/\.0$/, '')

/** 668265 -> "668,265": a count in full, for the figures that are read to be added up. */
export const exactTokens = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * What each request of a turn sent, in order. A turn kept in the session's state from before the requests were counted (a mod
 * reloaded in a running session keeps its state) has no such list: it reads as none counted.
 */
export const promptsOf = (t: TurnTokens): readonly number[] => (t as { prompts?: readonly number[] }).prompts ?? []

/** The whole prompt a turn sent: what the API bills in three kinds (uncached input, cache writes and cache reads), together. */
export const promptTokens = (t: TurnTokens): number => t.input + t.cacheWrite + t.cacheRead

export const formatUsd = (n: number): string => `$${n.toFixed(2)}`

/** `▓▓▓▓▓░░░░░` for 52 at width 10. */
export const bar = (percent: number, width = 10): string => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** Cells a text takes on a terminal: a Japanese character (full-width) takes two, the rest one. */
export const cellWidth = (text: string): number => {
  let cells = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const isWide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    cells += isWide ? 2 : 1
  }
  return cells
}

/**
 * Rows a text takes in a box `columns` cells across. Counted on the safe side: a full-width character that does not fit
 * the last cell of a row goes to the next, so a row holds one cell less than the box.
 */
export const wrappedRows = (text: string, columns: number): number =>
  text === '' ? 0 : Math.ceil(cellWidth(text) / Math.max(1, columns - 1))

/** A tool result's size in tokens, from its text; deliberately rough (about 3 characters a token). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

/** The tokens a response really spent: fresh input, cache writes and output; cache reads left out. */
export const turnTokens = (usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}, prompts: readonly number[] = []): TurnTokens => ({
  spent: usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
  input: usage.input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
  cacheRead: usage.cache_read_input_tokens,
  output: usage.output_tokens,
  model: usage.model,
  prompts,
})

/** "15:30" from an ISO timestamp, or undefined when it does not parse. */
export const clockLabel = (iso: string | undefined): string | undefined => {
  if (iso === undefined) return undefined
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(at.getHours())}:${two(at.getMinutes())}`
}

export const limitLabel = (kind: string): string => {
  if (kind === 'five_hour') return '5時間'
  if (kind === 'seven_day') return '週次'
  if (kind === 'spend_limit') return '利用額'
  return kind
}
