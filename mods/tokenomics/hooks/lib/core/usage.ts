/** What a response's usage says about the cache, and how long the person was away, in words the ledger may keep. */
export type UsageCounts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The share of the prompt the cache served: 1 is all of it, 0 is none. */
export const cacheShare = (u: UsageCounts): number => {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total === 0 ? 0 : u.cache_read_input_tokens / total
}

export type IdleBucket = 'lt1m' | '1to5m' | '5to15m' | '15to60m' | 'gt60m'

const MINUTE = 60_000

export const idleBucket = (ms: number): IdleBucket =>
  ms < MINUTE ? 'lt1m' : ms < 5 * MINUTE ? '1to5m' : ms < 15 * MINUTE ? '5to15m' : ms < 60 * MINUTE ? '15to60m' : 'gt60m'

export type ContextBucket = 'lt50k' | '50to100k' | '100to200k' | 'gt200k'

export const contextBucket = (tokens: number): ContextBucket =>
  tokens < 50_000 ? 'lt50k' : tokens < 100_000 ? '50to100k' : tokens < 200_000 ? '100to200k' : 'gt200k'

/** A turn that came after a pause and wrote most of its prompt into the cache again: the cache had lapsed, and this is what it cost. */
export const wasCold = (u: UsageCounts, idleMs: number | null, ttlMs: number): boolean => {
  if (idleMs === null || idleMs < ttlMs) return false
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total > 0 && u.cache_creation_input_tokens / total >= 0.5
}
