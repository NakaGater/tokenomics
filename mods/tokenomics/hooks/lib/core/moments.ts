import { similarity } from './downgrade'
import { type HeavyLevel, coldPenaltyUsd, warmTurnUsd } from './economics'

/** A conversation smaller than this has too little to lose for a change of subject to matter (about 20% of 200k). */
export const MIN_CONTEXT_TOKENS = 40_000
/** The lapsed-cache moment is for conversations at least this big. */
export const COLD_MIN_TOKENS = 50_000
/** Turns a `/clear` or a compaction counts as the answer to a suggestion that would have been made. */
export const ANSWER_TURNS = 3
/** Warm turns a `/clear` is assumed to save, for the ledger's figure of what was at stake. */
export const CLEAR_SAVES_TURNS = 10

export type ShiftReason = 'keyword' | 'gap' | 'lowsim' | 'nofile'

export type PromptFacts = {
  text: string
  /** The person's previous prompt in this conversation, if any. Kept in memory only. */
  previous: string | null
  /** Files the conversation has touched lately (paths, as the tools were given them). Kept in memory only. */
  touched: readonly string[]
  contextTokens: number | null
  /** Milliseconds since the last turn ended, if one has. */
  idleMs: number | null
  ttlMs: number
}

export type Shift = {
  score: number
  reasons: ShiftReason[]
  /** One weak sign and no more: where a question to a model would be worth its cost. */
  isUncertain: boolean
  /** The conversation is big enough and the signs strong enough that a suggestion to start fresh would have been made. */
  wouldFire: boolean
}

// Words that say the next thing is another thing.
const KEYWORDS = /別件|別の件|別の話|話は変わ|話変わ|ところで|それとは別|次は|別のタスク|別の作業|next task|unrelated|different topic|new topic|switching to|on another note|separate (?:task|issue)/i

// A path-looking word: with a folder in it, or with a file extension the work usually has.
const PATHS =
  /[\w@.-]+\/[\w@./-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|json|md|java|kt|swift|py|rs|go|css|scss|html|yml|yaml|xml|gradle|sh|sql|toml)\b/g

export const pathsIn = (text: string): string[] => [...new Set(text.match(PATHS) ?? [])]

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const sameFile = (mentioned: string, touched: string): boolean =>
  touched.endsWith(mentioned) || mentioned.endsWith(touched) || baseName(mentioned) === baseName(touched)

/** Whether the prompt looks like another subject than the conversation has been on. Cheap rules only; no model is asked. */
export const topicShift = (p: PromptFacts): Shift => {
  const reasons: ShiftReason[] = []
  let score = 0
  if (KEYWORDS.test(p.text)) {
    reasons.push('keyword')
    score += 2
  }
  if (p.idleMs !== null && p.idleMs >= p.ttlMs) {
    reasons.push('gap')
    score += 1
  }
  if (p.previous !== null && p.text.trim().length >= 8 && similarity(p.text, p.previous) < 0.08) {
    reasons.push('lowsim')
    score += 1
  }
  const mentioned = pathsIn(p.text)
  if (mentioned.length > 0 && p.touched.length > 0 && !mentioned.some(m => p.touched.some(t => sameFile(m, t)))) {
    reasons.push('nofile')
    score += 1
  }
  const isBig = p.contextTokens !== null && p.contextTokens >= MIN_CONTEXT_TOKENS
  return { score, reasons, isUncertain: isBig && score === 1, wouldFire: isBig && score >= 2 }
}

export type ClassifyState = {
  /** Prompts since a model was last asked. */
  promptsSince: number
  /** Questions to a model this session. */
  asked: number
  contextTokens: number | null
}

export const CLASSIFY = { minContextTokens: 50_000, everyPrompts: 10, perSession: 3 } as const

/** Whether the doubtful case is worth a question to a model: rarely, and only for a conversation that is worth it. Not asked in this build. */
export const shouldClassify = (shift: Shift, s: ClassifyState): boolean =>
  shift.isUncertain &&
  (s.contextTokens ?? 0) >= CLASSIFY.minContextTokens &&
  s.promptsSince >= CLASSIFY.everyPrompts &&
  s.asked < CLASSIFY.perSession

const RANK: Record<'notice' | 'strong', number> = { notice: 1, strong: 2 }

/** The level a conversation has newly reached, or null: a level already spoken of is not spoken of again until it has been left. */
export const risen = (latched: HeavyLevel, now: HeavyLevel): 'notice' | 'strong' | null =>
  now !== null && RANK[now] > (latched === null ? 0 : RANK[latched]) ? now : null

export type ColdReturn = { isCold: boolean; penaltyUsd: number | null }

/** A prompt after a pause longer than the cache lives, on a conversation big enough for that to cost something. */
export const coldReturn = (idleMs: number | null, ttlMs: number, tokens: number | null, model: string | undefined): ColdReturn => {
  const isCold = idleMs !== null && idleMs >= ttlMs && tokens !== null && tokens >= COLD_MIN_TOKENS
  return { isCold, penaltyUsd: isCold && tokens !== null ? coldPenaltyUsd(tokens, model) : null }
}

/** What starting fresh would spare, roughly: the warm reads of the conversation over the next few turns. */
export const clearStakeUsd = (tokens: number | null, model: string | undefined): number | null =>
  tokens === null ? null : ((warm: number | null) => (warm === null ? null : warm * CLEAR_SAVES_TURNS))(warmTurnUsd(tokens, model))
