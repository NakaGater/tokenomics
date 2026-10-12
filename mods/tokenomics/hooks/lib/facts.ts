import type { BigOutput, Facts, RateLimit, RequestSize, RequestUsage, SessionTotals, TurnTokens } from '../../types'

import { THRESHOLDS, computeAdvice, scaledPercent } from './advice'
import { promptsOf } from './format'

export const noSession: SessionTotals = { turns: 0, requestTurns: 0, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }

/** The session's totals; a state kept from a build before they were counted has none, and reads as nothing counted. */
export const sessionOf = (f: Facts): SessionTotals => (f as { session?: SessionTotals }).session ?? noSession

/** How many requests the chart keeps. */
export const RECENT_REQUESTS = 10

/** The last requests; a state kept from a build before they were kept has none. */
export const recentOf = (f: Facts): readonly RequestUsage[] => (f as { recent?: readonly RequestUsage[] }).recent ?? []

const withTurn = (s: SessionTotals, t: TurnTokens): SessionTotals => {
  const requests = promptsOf(t).length
  return {
    turns: s.turns + 1,
    requestTurns: s.requestTurns + (requests > 0 ? 1 : 0),
    requests: s.requests + requests,
    input: s.input + t.input,
    cacheWrite: s.cacheWrite + t.cacheWrite,
    cacheRead: s.cacheRead + t.cacheRead,
    output: s.output + t.output,
  }
}

export const initialFacts: Facts = {
  contextPercent: null,
  contextTokens: null,
  contextWindow: null,
  conversationTokens: null,
  baselineTokens: null,
  costUsd: null,
  rateLimits: [],
  last: null,
  session: noSession,
  recent: [],
  turns: 0,
  bigOutput: null,
  pausedContext: null,
  cacheLapse: null,
  endedAt: null,
  promptChars: 0,
  lightStreak: 0,
  agentTokens: 0,
  agentRuns: 0,
  agentTokensThisTurn: 0,
  resumeCold: null,
  hasGrown: false,
  autoCompactThreshold: null,
  autoCompactSource: null,
  autoCompactWindow: null,
  stepEffort: null,
  boundary: null,
  isAutoCompactEnabled: null,
  canSetAutoCompact: false,
  isSuggestEnabled: null,
  isMotionReduced: false,
}

/** What `session.measure` and `$.session.usage()` both carry. */
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly RateLimit[]
  cost?: { usd: number }
}

export const applyMeasure = (f: Facts, m: Measure): Facts => {
  const next: Facts = {
    ...f,
    contextPercent: m.context.percent ?? f.contextPercent,
    contextTokens: m.context.tokens ?? f.contextTokens,
    contextWindow: m.context.window,
    costUsd: m.cost?.usd ?? f.costUsd,
    rateLimits: m.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
  // Once heavy, always so for the session: a compaction lightens the conversation, not the fact that it grew.
  return !next.hasGrown && (scaledPercent(next) ?? 0) >= THRESHOLDS.contextNotice ? { ...next, hasGrown: true } : next
}

/** A small turn: a short prompt, at most a tool call or so, a short answer on screen. */
const isLightTurn = (f: Facts, tools: number, answerChars: number): boolean =>
  f.promptChars <= THRESHOLDS.lightPromptChars && tools <= THRESHOLDS.lightTools && answerChars <= THRESHOLDS.lightAnswerChars

/**
 * A turn ended. Following a pause, its usage says whether the cache really lapsed: it wrote the
 * conversation back. `tools` is how many calls the turn made, counted outside the facts, and
 * `answerChars` the length of the answer shown.
 */
export const applyTurn = (
  f: Facts,
  turn: TurnTokens,
  endedAt: number,
  tools: number,
  answerChars: number,
  /** The turn was set going by something sent in (an agent's hand-back, a schedule), not by the person: it says nothing of how small their requests are. */
  isSentIn = false,
  /** What each request of the turn sent, in order. */
  requests: readonly RequestSize[] = [],
): Facts => ({
  ...f,
  last: turn,
  session: withTurn(sessionOf(f), turn),
  recent: [...recentOf(f), ...requests.map(r => ({ ...r, turn: f.turns + 1 }))].slice(-RECENT_REQUESTS),
  turns: f.turns + 1,
  endedAt,
  lightStreak: isSentIn ? f.lightStreak : isLightTurn(f, tools, answerChars) ? f.lightStreak + 1 : 0,
  pausedContext: null,
  cacheLapse:
    f.pausedContext !== null && turn.cacheWrite >= f.pausedContext * THRESHOLDS.cacheLapseShare
      ? { tokens: turn.cacheWrite }
      : null,
})

/** The cache may have lapsed over a pause: the context's size then, which the next turn's usage will confirm or not. */
const pausedContextOf = (f: Facts, now: number, minIdleMs: number, minContextTokens: number): number | null =>
  f.endedAt !== null && now - f.endedAt >= minIdleMs && (f.contextTokens ?? 0) >= minContextTokens ? f.contextTokens : null

/**
 * Something sent in set a turn going (an agent's hand-back, a schedule, another session): the pause before it still
 * counts toward a lapsed cache, which it reads again all the same, but nothing else about the person's turn changes.
 */
export const applySentIn = (f: Facts, now: number, minIdleMs: number, minContextTokens: number): Facts => ({
  ...f,
  pausedContext: pausedContextOf(f, now, minIdleMs, minContextTokens),
})

/** A new prompt starts a new turn: last turn's large output and boundary are old news, and the pause before it is noted. */
export const applyPrompt = (f: Facts, now: number, minIdleMs: number, minContextTokens: number, promptChars: number): Facts => ({
  ...f,
  promptChars,
  agentTokensThisTurn: 0,
  // The first reply after a resume is the one that reads everything again; once a prompt is sent, it is under way.
  resumeCold: null,
  bigOutput: null,
  boundary: null,
  cacheLapse: null,
  pausedContext: pausedContextOf(f, now, minIdleMs, minContextTokens),
})

/** The effort the main conversation asks for; the same value again leaves the facts as they were. */
export const applyStep = (f: Facts, effort: string | number | undefined): Facts => {
  const seen = typeof effort === 'string' ? effort : null
  return seen === f.stepEffort ? f : { ...f, stepEffort: seen }
}

export const applyConversation = (f: Facts, tokens: number): Facts => (f.conversationTokens === tokens ? f : { ...f, conversationTokens: tokens })

/** What an empty session holds: the window's tokens less the conversation's own, as one reading of both says. */
/** A subagent's (or workflow agent's, or teammate's) turn ended: its tokens are the session's too, though not the main loop's. */
export const applyAgentTurn = (f: Facts, spent: number): Facts => ({
  ...f,
  agentTokens: f.agentTokens + spent,
  agentRuns: f.agentRuns + 1,
  agentTokensThisTurn: f.agentTokensThisTurn + spent,
})

/** A session picked up where it was left, after the prompt cache had probably lapsed. */
export const applyResume = (f: Facts, resume: { tokens: number; usd: number; idleMinutes: number }): Facts => ({ ...f, resumeCold: resume })

export const applyBaseline = (f: Facts, tokens: number, conversation: number): Facts => {
  const baseline = Math.max(0, tokens - conversation)
  return f.baselineTokens === baseline ? f : { ...f, baselineTokens: baseline }
}

export const applyBoundary =(f: Facts, boundary: 'commit' | 'cwd'): Facts => ({ ...f, boundary })

export const applyBigOutput = (f: Facts, output: BigOutput): Facts =>
  f.bigOutput !== null && f.bigOutput.tokens >= output.tokens ? f : { ...f, bigOutput: output }

/** After a compaction the window holds `tokensAfter` until the next response says otherwise. */
export const applyCompacted = (f: Facts, tokensAfter: number | undefined): Facts => {
  if (tokensAfter === undefined || f.contextWindow === null) return f
  return {
    ...f,
    contextTokens: tokensAfter,
    conversationTokens: null,
    contextPercent: Math.min(100, Math.round((tokensAfter / f.contextWindow) * 100)),
  }
}

/** `/clear` empties the conversation but not the session's cost or the person's limits. */
export const applyCleared = (f: Facts): Facts => ({
  ...f,
  contextPercent: 0,
  contextTokens: 0,
  conversationTokens: 0,
  last: null,
  session: noSession,
  recent: [],
  turns: 0,
  agentTokens: 0,
  agentRuns: 0,
  agentTokensThisTurn: 0,
  resumeCold: null,
  hasGrown: false,
  bigOutput: null,
  boundary: null,
  lightStreak: 0,
  pausedContext: null,
  cacheLapse: null,
  endedAt: null,
})

/**
 * Keeps only the dismissals whose advice is still being given, so a thing the
 * person put off comes back the next time its condition begins again, never sooner.
 */
export const pruneDismissed = (dismissed: string[], f: Facts): string[] => {
  if (dismissed.length === 0) return dismissed
  const live = new Set(computeAdvice(f).map(a => a.id))
  const kept = dismissed.filter(id => live.has(id))
  // The same array when nothing ended, so the write does not redraw anyone for nothing.
  return kept.length === dismissed.length ? dismissed : kept
}
