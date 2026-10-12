import type { Facts } from '../../types'

import { warmTurnUsd } from './core/economics'
import { formatTokens } from './format'

/**
 * What a summary leaves of a conversation: measured on this machine (17 compactions) the summary is 11k tokens at the median and 15k
 * at the most; the rest of what a conversation starts with (system prompt, tools, skills, memory) is read off the session.
 */
export const SUMMARY_TOKENS = 12_000
/** The start of a conversation where it has not been measured yet. */
export const FALLBACK_BASELINE_TOKENS = 28_000

/** What every request costs just to carry the conversation, and what it would cost after a summary. */
export type Stake = {
  tokens: number
  afterTokens: number
  /** How many times smaller the conversation would be. */
  times: number
  /** Dollars of one request's reading of it at list prices; null on a subscription, or for a model not in the list. */
  usd: number | null
  afterUsd: number | null
  /** Big enough, against what a summary leaves, to be worth saying a summary would help. */
  isWorthSaying: boolean
}

export const stakeOf = (f: Facts): Stake | null => {
  if (f.contextTokens === null || f.contextTokens <= 0) return null
  const afterTokens = (f.baselineTokens ?? FALLBACK_BASELINE_TOKENS) + SUMMARY_TOKENS
  // Off a subscription the dollars are what is spent; on one they are only a notional price, which this leaves out.
  const isDollars = f.rateLimits.length === 0
  const model = f.last?.model
  return {
    tokens: f.contextTokens,
    afterTokens,
    times: f.contextTokens / afterTokens,
    usd: isDollars ? warmTurnUsd(f.contextTokens, model) : null,
    afterUsd: isDollars ? warmTurnUsd(afterTokens, model) : null,
    isWorthSaying: f.contextTokens >= 2 * afterTokens,
  }
}

/** A request's dollars: three places under a dime, since it is thousandths that matter here. */
const perRequest = (usd: number): string => (usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`)

// With dollars the bracket closes the figure; without, a space keeps "tok" off the word after it.
const sized = (tokens: number, usd: number | null): string => `${formatTokens(tokens)} tok${usd === null ? ' ' : `（約 ${perRequest(usd)}）`}`

/** "毎回 420k tok（約 $0.042）を読み直す。要約すると約 40k tok（約 $0.004）で、およそ 1/10 になる" */
export const stakeText = (s: Stake): string =>
  s.isWorthSaying
    ? `毎回 ${sized(s.tokens, s.usd)}を読み直す。要約すると約 ${sized(s.afterTokens, s.afterUsd)}で、およそ 1/${Math.round(s.times)} になる`
    : `毎回 ${sized(s.tokens, s.usd)}を読み直す`
