export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** One main-loop turn, in the tokens it spent. `spent` leaves out cache reads: they dominate a tool-heavy turn and cost little. */
export type TurnTokens = {
  spent: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  model: string
  /**
   * What each model request of the turn sent, in order: its whole prompt (uncached + cache writes + cache reads), as the API
   * counted it. Its length is the number of requests; empty when they were not counted.
   */
  prompts: readonly number[]
}

/** One model request of the main loop, as the API counted it, in the kinds that are billed apart. */
export type RequestSize = {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  /**
   * The request called the advisor. The advisor's own model call is not in the counts, and the main model's two passes around it
   * are added up in them, so the prompt reads about twice the conversation.
   */
  isAdvisor: boolean
}

/** A request kept for the chart: which turn of the session it belonged to. */
export type RequestUsage = RequestSize & { turn: number }

/**
 * What the session's turns have sent and received, as the API counted it: sums over their requests, in the kinds that are
 * billed apart. `turns` is how many turns are in it, which is fewer than the session's where the mod was reloaded from a build
 * that did not keep this; `requestTurns` is how many of those had their requests counted.
 */
export type SessionTotals = {
  turns: number
  requestTurns: number
  requests: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/** The largest tool result of the current turn, when it is large enough to be worth a word. */
export type BigOutput = { id: string; tool: string; tokens: number; target?: string }

/** Everything the band, the pane and the advice read; written only from events. */
export type Facts = {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  /** The conversation itself, less the system prompt, tools and the rest the window holds from the start; null until measured. */
  conversationTokens: number | null
  /** What the window holds before any conversation (prompt, tools, skills, memory), read once a response has measured it; null until then. */
  baselineTokens: number | null
  costUsd: number | null
  rateLimits: RateLimit[]
  last: TurnTokens | null
  /** `last` is the running turn's, summed over the requests it has had so far, not a finished turn's; absent in a state kept from an older build. */
  isLastRunning?: boolean
  /** What the session's turns add up to; read through `sessionOf`, since a state kept from an older build lacks it. */
  session: SessionTotals
  /** The last requests of the main loop, oldest first, across turns; read through `recentOf`, since a state kept from an older build lacks it. */
  recent: readonly RequestUsage[]
  turns: number
  bigOutput: BigOutput | null
  /** The context's size when a prompt came after a long pause: the cache may have lapsed, and the turn's usage will say. */
  pausedContext: number | null
  /** A turn that did re-read the conversation after a pause, with the tokens it wrote back into the cache. */
  cacheLapse: { tokens: number } | null
  /** When the last main-loop turn ended, in `$.clock.now()` milliseconds. */
  endedAt: number | null
  /** Length of the prompt the running (or last) turn began with, in characters. */
  promptChars: number
  /** How many turns in a row were small: a short prompt, at most one tool call, a short answer. */
  lightStreak: number
  /** Tokens subagents (and workflow agents, teammates) have spent this session, and how many of their turns that was; the band counts the main loop's own. */
  agentTokens: number
  agentRuns: number
  /** What subagents have spent since the last prompt. */
  agentTokensThisTurn: number
  /** The session was resumed after the prompt cache had probably lapsed: what the first reply will read again. Cleared by the next prompt. */
  resumeCold: { tokens: number; usd: number; idleMinutes: number } | null
  /** The conversation has been heavy at some point this session (past the first notice level), even if a compaction has lightened it since. */
  hasGrown: boolean
  /** The size the engine auto-compacts at, from the breakdown; null while auto-compaction is off or not yet read. */
  autoCompactThreshold: number | null
  /** Who set that size (`auto`, `model-default`, `settings`, `env` ...), as the breakdown names it. */
  autoCompactSource: string | null
  /** The size auto-compaction is counted against (`/autocompact`'s value, or the model's own window); a state kept from an older build lacks it. */
  autoCompactWindow?: number | null
  /** The effort the main conversation's last model step asked for. */
  stepEffort: string | null
  /** The turn did something that usually ends a piece of work: a commit, a pull request, a change of folder. */
  boundary: 'commit' | 'cwd' | null
  isAutoCompactEnabled: boolean | null
  /** The /config row for autocompact exists and no policy owns it, so the mod may offer to turn it on. */
  canSetAutoCompact: boolean
  /** The /config row "Prompt suggestions": each reply is followed by a small request for the next prompt's wording. */
  isSuggestEnabled: boolean | null
  /** The /config row "Reduce motion" is on: the cat stands still, a picture for each state. */
  isMotionReduced: boolean
}

/** The effort a person may cap turns at: lower than the session's own, never higher. */
export type EffortSetting = 'low' | 'medium'

/** What the person has accepted. Every one starts off, and starts off again with each session. */
export type Modes = {
  /** Cap on how hard turns think; null leaves the session's own setting. */
  effort: EffortSetting | null
  /** The light read-only helper is offered to the model. */
  isWorkerOn: boolean
  /** Every compaction, the engine's too, is preceded by a note of what it would lose, saved to a file. */
  isHandoffOn: boolean
  /** The model the person had before the mod switched it, so it can be put back. */
  previousModel: string | null
  /** Notes written so far; numbers the next. */
  handoffs: number
}

/**
 * What today's ledger says the mod has done for the person, for the pane. Two kinds of figure, never added together:
 * the digest's (`digests`, `tokens`, `milliUsd`: outputs that were cut; `recovered` of them the model went back for), and the
 * estimate for work handed to the plugin's skills and agents (`forks` runs kept `keptTokens` of reading out of the conversation,
 * `milliUsd` thousandths of a dollar; of the `forkReaders` that read files, `forkRereads` files were read again by the conversation).
 * `wouldFire` counts the suggestions it would have made.
 */
export type Savings = {
  digests: number
  tokens: number
  milliUsd: number
  wouldFire: number
  recovered: number
  forks: number
  keptTokens: number
  keptMilliUsd: number
  forkReaders: number
  forkRereads: number
  /** What the runs handed over cost on the input side (thousandths of a dollar, list prices), and how many gained nothing. */
  forkCostMilliUsd: number
  forkLosses: number
}

/** The /config Model row: what it holds now and the values it takes. */
export type ModelRow = { value: string; options: string[] }

/** The suggestions the mod makes: each a way to spend fewer tokens that the person may accept. */
export type OfferKind = 'compact' | 'autocompact' | 'window' | 'boundary' | 'worker' | 'model' | 'effort' | 'suggest'

/** The suggestion on screen now, and where: a dialog pane, or a card above the band where no pane fits. */
export type OpenOffer = { id: string; kind: OfferKind; view: 'dialog' | 'card' }

/** One row of "what is heavy": a context category, its tokens and what to do about it. */
export type HeavyItem = { name: string; tokens: number; hint?: string; details?: string[] }

declare module 'claude-code' {
  interface PluginState {
    tokenomics: {
      facts: Facts
      /** Advice ids the person put off; an id is forgotten once its condition no longer holds. */
      dismissed: string[]
      /** The context breakdown for the pane; null until the pane asked for it. */
      heavy: HeavyItem[] | null
      /** What the mod is doing for the person right now, so the band can say so. */
      busy: 'compact' | null
      modes: Modes
      modelRow: ModelRow | null
      /** The suggestion on screen, if any. */
      offer: OpenOffer | null
      /** Suggestions already made this session; a heavy-context one is forgotten when that situation ends. */
      seen: string[]
      /** Kinds the person asked not to be shown again; kept past the session in `$.store`. */
      muted: OfferKind[]
      /** What the savings layer has done today, from its ledger. */
      savings: Savings
      /** The one-line suggestion made after the last reply, shown in the cat's card until the next prompt; null when none. */
      nudge: string | null
      /** The auto-compact size the person has stepped to or set in the pane; null until they do (the recommended one is shown). */
      windowPick: number | null
      /** The mod is setting the auto-compact size, and the pane's buttons wait. */
      isSettingWindow: boolean
    }
  }
}
