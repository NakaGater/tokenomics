/**
 * What tokens cost, from the official price list (fetched 2026-10-10). Input and cache prices only: output
 * (thinking included) is left out on purpose, since no reliable figure is at hand, so every figure here is the
 * input side of the bill. An administrator's own contract prices (`modelPricing`) are not readable from a mod.
 */
export type Family = 'opus' | 'sonnet' | 'haiku' | 'fable'

/** US dollars per million tokens. */
export type Price = { input: number; write5m: number; write1h: number; read: number }

export const PRICES: Record<Family, Price> = {
  sonnet: { input: 2, write5m: 2.5, write1h: 4, read: 0.1 },
  opus: { input: 4, write5m: 5, write1h: 8, read: 0.2 },
  // Haiku's writes are the standard 1.25x and 2x of its input; its read is listed.
  haiku: { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01 },
  // Fable's list is not in hand: priced like Opus until it is. `isAssumed` says so.
  fable: { input: 4, write5m: 5, write1h: 8, read: 0.2 },
}

/** Haiku costs five times as much on a prompt over this size. */
const HAIKU_LARGE_PROMPT = 100_000

export const isAssumed = (family: Family): boolean => family === 'fable'

/** The family a model id belongs to (`claude-opus-5-5`, `sonnet[1m]`, `haiku`), or null when it is none of them. */
export const modelFamily = (model: string | undefined): Family | null => {
  const id = (model ?? '').toLowerCase()
  if (id.includes('opus')) return 'opus'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('haiku')) return 'haiku'
  if (id.includes('fable')) return 'fable'
  return null
}

export type Ttl = '5m' | '1h'

const priceOf = (family: Family, tokens: number): Price => {
  const p = PRICES[family]
  return family === 'haiku' && tokens > HAIKU_LARGE_PROMPT ? { input: p.input * 5, write5m: p.write5m * 5, write1h: p.write1h * 5, read: p.read * 5 } : p
}

const perMillion = (tokens: number, usd: number): number => (tokens * usd) / 1_000_000

/** What one turn costs to read a conversation of `tokens` from a warm cache; null for a model not in the list. */
export const warmTurnUsd = (tokens: number, model: string | undefined): number | null => {
  const family = modelFamily(model)
  return family === null ? null : perMillion(tokens, priceOf(family, tokens).read)
}

/** What it costs to write a conversation of `tokens` into the cache: the price of a first turn, or of one after the cache lapsed. */
export const coldTurnUsd = (tokens: number, model: string | undefined, ttl: Ttl = '5m'): number | null => {
  const family = modelFamily(model)
  if (family === null) return null
  const p = priceOf(family, tokens)
  return perMillion(tokens, ttl === '5m' ? p.write5m : p.write1h)
}

/** What a lapsed cache adds to the next turn, against a warm one. */
export const coldPenaltyUsd = (tokens: number, model: string | undefined, ttl: Ttl = '5m'): number | null => {
  const cold = coldTurnUsd(tokens, model, ttl)
  const warm = warmTurnUsd(tokens, model)
  return cold === null || warm === null ? null : cold - warm
}

/**
 * How many input tokens one token of context is worth over the `turns` that follow it in the conversation:
 * written once into the cache, then read every turn. A big tool result that enters early costs this many times its size.
 */
export const contextFactor = (turns: number, ttl: Ttl = '5m'): number => (ttl === '5m' ? 1.25 : 2) + 0.05 * Math.max(0, turns)

/** What `tokens` kept out of the conversation save over the `turns` that follow, in dollars. */
export const keptOutUsd = (tokens: number, model: string | undefined, turns: number, ttl: Ttl = '5m'): number | null => {
  const family = modelFamily(model)
  return family === null ? null : perMillion(tokens, priceOf(family, tokens).input) * contextFactor(turns, ttl)
}

/** Turns assumed to follow a result when none is known; ledger figures name this guess. */
export const ASSUMED_TURNS_AFTER = 30

/** A turn that costs this much just to read the conversation is worth a word; twice this, a strong one. */
export const WARM_NOTICE_USD = 0.02
export const WARM_STRONG_USD = 0.04
/** Where a heavy conversation begins when dollars do not apply (a subscription, a model not in the list). */
export const HEAVY_NOTICE_TOKENS = 100_000
export const HEAVY_STRONG_TOKENS = 200_000

export type HeavyLevel = 'notice' | 'strong' | null

/** How heavy a conversation is by what each turn costs to read it, or by size alone where dollars do not apply. */
export const heavyLevel = (tokens: number, model: string | undefined, isSubscription: boolean): HeavyLevel => {
  const warm = isSubscription ? null : warmTurnUsd(tokens, model)
  if (warm === null) return tokens >= HEAVY_STRONG_TOKENS ? 'strong' : tokens >= HEAVY_NOTICE_TOKENS ? 'notice' : null
  return warm >= WARM_STRONG_USD ? 'strong' : warm >= WARM_NOTICE_USD ? 'notice' : null
}

/** Dollars as whole thousandths of a dollar: what the ledger keeps (it holds integers, not floats). */
export const milliUsd = (usd: number | null): number => (usd === null ? 0 : Math.round(usd * 1000))
