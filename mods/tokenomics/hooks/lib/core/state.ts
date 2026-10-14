import type { BatchGroup } from './batch'
import type { RecentSpawn } from './downgrade'
import type { ForkRun } from './forks'
import type { KeptItem } from './flow'
import type { Candidate } from './nudges'
import { type SteerState, freshSteer } from './steer'
import type { HeavyLevel } from './economics'
import { type Ledger, type RawEvent, emptyLedger, sessionKey } from './ledger'
import type { CoreOptions } from './options'
import type { Arm, Breaker, MeasureId } from './policy'
import type { KnownNote } from './spend'

/**
 * What the savings layer remembers while the module is loaded. It is memory only: none of it is written out except as
 * counts in the ledger. A reload of the module starts it over, and so does a new session (`resetSession`).
 */
export type CoreState = {
  options: CoreOptions
  arm: Arm
  /** The session, as a short hash. */
  sid: string
  ledger: Ledger
  /** Events not yet written to the store. */
  pending: RawEvent[]
  breaker: Breaker
  /** Where this session's saved outputs go; empty until the session is known. */
  saveDir: string
  /** The place for them is the person's own: the OS temp folder, where `TMPDIR` is set. False until it is known. */
  canSave: boolean
  mainModel: string | undefined
  contextTokens: number | null
  isSubscription: boolean
  /** Turns the main conversation has finished. */
  turnIndex: number
  lastEndedAt: number | null
  /** How long the person was away before the prompt the running turn began with. */
  lastIdleMs: number | null
  lastPrompt: string | null
  /** Files the work has touched lately, as the tools were given them. */
  touched: string[]
  latched: HeavyLevel
  /** The last suggestion that would have been made, so a compaction or a fresh start soon after can be counted as the answer. */
  lastWould: { measure: MeasureId; turn: number } | null
  recentSpawns: RecentSpawn[]
  /** Subagent id to its kind, for counting what each kind spends. */
  spawns: Map<string, string>
  /** What each subagent has read and, once its turn ended, handed back: settled when its kind is known (`forks.ts`). */
  forks: Map<string, ForkRun>
  /** Outputs that were cut, by tool call, to notice the model going back for them. */
  digests: Map<string, { command: string; turn: number }>
  /** Suggestions that have arisen and wait for the next reply to end. */
  candidates: Candidate[]
  /** The turn the last suggestion was made on. */
  shownAtTurn: number | null
  /** The last suggestion made, until it is answered or left unanswered. */
  lastShown: { measure: MeasureId; turn: number } | null
  /** Suggestion kinds that have been made so often to so little effect that they are no longer made. */
  retired: string[]
  /** `/tokenomics nudge-test` was asked for: the next reply ends with a sample line. */
  demoNudge: boolean
  /** The turn that just ended wrote its prompt into the cache again after a pause. */
  isColdTurn: boolean
  /** A person is at the other end (a terminal), not a script. */
  isInteractive: boolean
  /** Files each subagent has read, to notice the main conversation reading them again. Paths stay in memory. */
  agentReads: Map<string, Set<string>>
  /** The turn each subagent that read something finished on. */
  agentDone: Map<string, number>
  /** Subagent and path pairs already counted as read again. */
  rereads: Set<string>
  /** B6: what is remembered of the searches and test runs the main conversation has made. */
  steer: SteerState
  /** Saved outputs the model has already gone back for, so each is counted once however many pieces it reads. */
  readBack: Set<string>
  /** The notes written this session by file name (never the path), to count a note's first opening (`spend.ts`). */
  notes: Map<string, KnownNote>
  /** B7: what the session was written down as in the ledger (once per session, however often the prompt is composed). */
  isBatchNoted: boolean
  /**
   * What the savings layer has kept out of the main conversation and that is still out of it, by tool use (digest) or subagent
   * (delegation): each is spared from every request until the window is cleared or compacted (`lib/core/flow`).
   */
  kept: Map<string, KeptItem>
  /** Tokens that went into `kept` since the last request began: the request they first miss writes the cache for them. */
  keptFresh: number
  /** Counted up at every /clear and compaction: a run that ended in an earlier window keeps nothing out of this one. */
  epoch: number
  /** B7: the half this session is in, once it is known that the sentence is being made a question of (`auto`, a prompt that takes a section); null otherwise. */
  batchGroup: BatchGroup | null
}

export const freshState = (options: CoreOptions): CoreState => ({
  options,
  arm: 'treat',
  sid: sessionKey('unknown'),
  ledger: emptyLedger,
  pending: [],
  breaker: {},
  saveDir: '',
  canSave: false,
  mainModel: undefined,
  contextTokens: null,
  isSubscription: false,
  turnIndex: 0,
  lastEndedAt: null,
  lastIdleMs: null,
  lastPrompt: null,
  touched: [],
  latched: null,
  lastWould: null,
  recentSpawns: [],
  spawns: new Map(),
  forks: new Map(),
  digests: new Map(),
  candidates: [],
  shownAtTurn: null,
  lastShown: null,
  retired: [],
  demoNudge: false,
  isColdTurn: false,
  isInteractive: true,
  agentReads: new Map(),
  agentDone: new Map(),
  rereads: new Set(),
  steer: freshSteer(),
  readBack: new Set(),
  notes: new Map(),
  isBatchNoted: false,
  kept: new Map(),
  keptFresh: 0,
  epoch: 0,
  batchGroup: null,
})

/** A new session: what belonged to the last conversation is forgotten. */
export const resetSession = (s: CoreState): void => {
  s.turnIndex = 0
  s.lastEndedAt = null
  s.lastIdleMs = null
  s.lastPrompt = null
  s.touched = []
  s.latched = null
  s.lastWould = null
  s.recentSpawns = []
  s.spawns.clear()
  s.forks.clear()
  s.digests.clear()
  s.candidates = []
  s.shownAtTurn = null
  s.lastShown = null
  s.demoNudge = false
  s.isColdTurn = false
  s.agentReads.clear()
  s.agentDone.clear()
  s.rereads.clear()
  s.steer = freshSteer()
  s.readBack.clear()
  s.notes.clear()
  s.isBatchNoted = false
  s.batchGroup = null
  newWindow(s)
}

/** The conversation's window starts over (a /clear or a compaction): what was kept out of the old one no longer adds up. */
export const newWindow = (s: CoreState): void => {
  s.kept.clear()
  s.keptFresh = 0
  s.epoch += 1
}

/** `/clear`: the conversation is gone, the session goes on. */
export const resetConversation = (s: CoreState): void => {
  s.lastPrompt = null
  s.touched = []
  s.latched = null
  s.candidates = []
  s.steer = freshSteer()
  // The size of the old window, and how long the person was away from it, say nothing of the new one.
  s.contextTokens = null
  s.lastEndedAt = null
  s.lastIdleMs = null
  s.isColdTurn = false
  newWindow(s)
}

export const FILE_FIELDS = ['file_path', 'path', 'notebook_path'] as const

/** The files a tool call names, remembered (most recent last, at most 40). */
export const touch = (s: CoreState, input: Record<string, unknown>): void => {
  for (const key of FILE_FIELDS) {
    const value = input[key]
    if (typeof value !== 'string' || value === '') continue
    s.touched = [...s.touched.filter(t => t !== value), value].slice(-40)
  }
}
