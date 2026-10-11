import type { TurnTokens } from '../../types'

/** 950 -> "950", 3200 -> "3.2k", 48000 -> "48k", 1.2M -> "1.2M". */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${trimZero((n / 1_000_000).toFixed(1))}M`
}

const trimZero = (s: string): string => s.replace(/\.0$/, '')

export const formatUsd = (n: number): string => `$${n.toFixed(2)}`

/** `▓▓▓▓▓░░░░░` for 52 at width 10. */
export const bar = (percent: number, width = 10): string => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** A tool result's size in tokens, from its text; deliberately rough (about 3 characters a token). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

/** The tokens a response really spent: fresh input, cache writes and output; cache reads left out. */
export const turnTokens = (usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}): TurnTokens => ({
  spent: usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
  input: usage.input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
  cacheRead: usage.cache_read_input_tokens,
  output: usage.output_tokens,
  model: usage.model,
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
