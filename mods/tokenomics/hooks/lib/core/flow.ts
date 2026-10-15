import { coldTurnUsd, warmTurnUsd } from './economics'

/**
 * What the savings layer kept out of the main conversation stays out of every request that follows, until the conversation is
 * cleared or compacted. So the saving grows with the requests: a request that did not carry `tokens` of a cut output spared the
 * model reading them, and the first of them spared a cache write besides. Pure: the hook keeps the items still out of the
 * conversation and, at every request the main loop makes, asks what this one spared.
 */
export type KeptItem = {
  tokens: number
  /** A cut that happened (the output digest's) or the estimate for work handed to a skill or agent of the plugin. */
  kind: 'digest' | 'delegation'
}

/** What one request spared. `microUsd`: millionths of a dollar, input side, at list prices (0 for a model not in the list). */
export type RequestFlow = { digestTokens: number; delegationTokens: number; microUsd: number }

/**
 * What a request that carried none of `items` spared: all their tokens, the ones that came out since the last request
 * (`freshTokens`) priced as a cache write and the others as a cache read.
 */
export const requestFlow = (items: Iterable<KeptItem>, freshTokens: number, model: string | undefined): RequestFlow => {
  let digestTokens = 0
  let delegationTokens = 0
  for (const item of items) {
    if (item.kind === 'digest') digestTokens += item.tokens
    else delegationTokens += item.tokens
  }
  const total = digestTokens + delegationTokens
  const fresh = Math.min(Math.max(0, freshTokens), total)
  const usd = (coldTurnUsd(fresh, model) ?? 0) + (warmTurnUsd(total - fresh, model) ?? 0)

  return { digestTokens, delegationTokens, microUsd: Math.round(usd * 1_000_000) }
}
