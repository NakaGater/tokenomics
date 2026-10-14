import type { Savings } from '../../../types'

import { ownName } from './forks'
import { shortHash } from './hash'
import type { Mode } from './options'
import type { Arm } from './policy'

/**
 * The ledger: what each measure did and what came of it, kept as counts and sums by day, plus the last few events.
 * It holds no content of the person's: no prompt, no file name, no path, no command. Every word in it is one of a
 * short list the code chooses (`sanitize` refuses anything else), and every other value is a number.
 */
export type Kind = 'fired' | 'would' | 'shown' | 'accepted' | 'dismissed' | 'outcome' | 'signal' | 'error' | 'feedback'

const KINDS: readonly Kind[] = ['fired', 'would', 'shown', 'accepted', 'dismissed', 'outcome', 'signal', 'error', 'feedback']
const MODES: readonly Mode[] = ['off', 'observe', 'suggest', 'auto']
const ARMS: readonly Arm[] = ['treat', 'control']

export type LedgerEvent = {
  kind: Kind
  /** A measure (`A1`) or `S` for a signal that belongs to none. */
  measure: string
  mode: Mode
  arm: Arm
  /** One short word naming what happened (`rerun`, `Explore`); never free text. */
  tag?: string
  /** Numbers about it, by short name. */
  n?: Record<string, number>
  /** Counted and summed like any other, but not kept among the last events: for what happens every turn. */
  isQuiet?: boolean
}

export type RawEvent = LedgerEvent & { t: number; sid: string }

export type Day = { day: string; counts: Record<string, number>; sums: Record<string, number> }

export type Ledger = { v: 1; days: Day[]; recent: RawEvent[] }

export const emptyLedger: Ledger = { v: 1, days: [], recent: [] }

/** Days kept, raw events kept, and how big the whole may grow when written out. */
export const MAX_DAYS = 14
export const MAX_RECENT = 200
export const MAX_BYTES = 64_000
/** Counts kept for one day; any more are counted together as `other`. */
export const MAX_KEYS = 300

const MEASURE = /^(?:[A-Z][0-9]{1,2}|S)$/
// Letters, digits and `_ . : -` only: a path, a sentence or a command line cannot pass.
const TAG = /^[A-Za-z0-9_.:-]{1,40}$/
const NAME = /^[A-Za-z0-9_]{1,24}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The event as the ledger will keep it, or null when anything in it is not allowed. */
export const sanitize = (event: LedgerEvent): LedgerEvent | null => {
  if (!KINDS.includes(event.kind) || !MODES.includes(event.mode) || !ARMS.includes(event.arm)) return null
  if (!MEASURE.test(event.measure)) return null
  if (event.tag !== undefined && !TAG.test(event.tag)) return null
  const n: Record<string, number> = {}
  for (const [name, value] of Object.entries(event.n ?? {})) {
    if (!NAME.test(name) || typeof value !== 'number' || !Number.isFinite(value)) return null
    n[name] = Math.round(value)
  }
  return {
    kind: event.kind,
    measure: event.measure,
    mode: event.mode,
    arm: event.arm,
    ...(event.tag === undefined ? {} : { tag: event.tag }),
    ...(Object.keys(n).length === 0 ? {} : { n }),
    ...(event.isQuiet === true ? { isQuiet: true } : {}),
  }
}

/** The person's own calendar day (their clock, not UTC): "today" turns over at their midnight. */
export const dayOf = (now: number): string => new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

export const sessionKey = (sessionId: string): string => shortHash(sessionId)

const countKey = (e: LedgerEvent): string => `${e.measure}:${e.kind}:${e.mode}${e.tag === undefined ? '' : `:${e.tag}`}`

const size = (l: Ledger): number => JSON.stringify(l).length

/** The ledger held to its size: the oldest raw events go first, then the oldest days. */
const fit = (l: Ledger): Ledger => {
  let next = l
  while (size(next) > MAX_BYTES && next.recent.length > 0) next = { ...next, recent: next.recent.slice(Math.ceil(next.recent.length / 4)) }
  while (size(next) > MAX_BYTES && next.days.length > 1) next = { ...next, days: next.days.slice(1) }
  return next
}

/** The ledger with one event added. An event that is not allowed changes nothing. */
export const append = (ledger: Ledger, event: LedgerEvent, now: number, sid: string): Ledger => {
  const clean = sanitize(event)
  if (clean === null) return ledger
  const day = dayOf(now)
  const known = ledger.days.find(d => d.day === day)
  const base: Day = known ?? { day, counts: {}, sums: {} }
  const wanted = countKey(clean)
  const key = base.counts[wanted] !== undefined || Object.keys(base.counts).length < MAX_KEYS ? wanted : 'other'
  const counts = { ...base.counts, [key]: (base.counts[key] ?? 0) + 1 }
  const sums = { ...base.sums }
  for (const [name, value] of Object.entries(clean.n ?? {})) {
    const sumKey = `${clean.measure}:${name}`
    if (sums[sumKey] !== undefined || Object.keys(sums).length < MAX_KEYS) sums[sumKey] = (sums[sumKey] ?? 0) + value
  }
  const updated: Day = { day, counts, sums }
  const days = (known === undefined ? [...ledger.days, updated] : ledger.days.map(d => (d.day === day ? updated : d)))
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .slice(-MAX_DAYS)
  const recent = clean.isQuiet === true ? ledger.recent : [...ledger.recent, { ...clean, t: now, sid }].slice(-MAX_RECENT)
  return fit({ v: 1, days, recent })
}

export const appendRaw = (ledger: Ledger, raw: RawEvent): Ledger => {
  const { t, sid, ...event } = raw
  return append(ledger, event, t, sid)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const numbers = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!isRecord(value)) return out
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  return out
}

/** What `$.store` gave back, held to the shape the ledger has; anything else is an empty ledger. */
export const parseLedger = (raw: unknown): Ledger => {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.days)) return emptyLedger
  const days: Day[] = raw.days.flatMap(d =>
    isRecord(d) && typeof d.day === 'string' && DAY.test(d.day) ? [{ day: d.day, counts: numbers(d.counts), sums: numbers(d.sums) }] : [],
  )
  const recent: RawEvent[] = (Array.isArray(raw.recent) ? raw.recent : []).flatMap(r => {
    if (!isRecord(r) || typeof r.t !== 'number' || typeof r.sid !== 'string') return []
    const event = sanitize(r as unknown as LedgerEvent)
    return event === null ? [] : [{ ...event, t: r.t, sid: r.sid }]
  })
  return fit({ v: 1, days: days.slice(-MAX_DAYS), recent: recent.slice(-MAX_RECENT) })
}

/** The days from `now` back `n` days (today included). */
export const lastDays = (ledger: Ledger, now: number, n: number): Day[] => {
  const from = dayOf(now - (n - 1) * 86_400_000)
  return ledger.days.filter(d => d.day >= from)
}

/** The sum of the counts whose key `match` accepts, over the last `n` days. */
export const sumCounts = (ledger: Ledger, now: number, n: number, match: (key: string) => boolean): number =>
  lastDays(ledger, now, n).reduce((total, d) => total + Object.entries(d.counts).reduce((t, [k, v]) => (match(k) ? t + v : t), 0), 0)

export const sumOf = (ledger: Ledger, now: number, n: number, name: string): number =>
  lastDays(ledger, now, n).reduce((total, d) => total + (d.sums[name] ?? 0), 0)

/** How the output digest is doing over the last week: how many it made, and how many the model had to go back for. */
export const digestHealth = (ledger: Ledger, now: number): { fired: number; recovered: number; rate: number } => {
  const fired = sumCounts(ledger, now, 7, k => k.startsWith('A1:fired:'))
  const recovered = sumCounts(ledger, now, 7, k => k.startsWith('A1:outcome:') && (k.endsWith(':rerun') || k.endsWith(':readback')))
  return { fired, recovered, rate: fired === 0 ? 0 : recovered / fired }
}

/** The size above which a command output is digested: raised when the model keeps going back for the rest; null stops the digest. */
export const digestThreshold = (ledger: Ledger, now: number, base: number): number | null => {
  const { fired, rate } = digestHealth(ledger, now)
  if (fired < 20) return base
  if (rate > 0.5) return null
  return rate > 0.25 ? base * 2 : base
}

/** A key `measure:kind:mode[:tag]` taken apart; the tag may hold colons (`tokenomics:scout`). */
const partsOf = (key: string): { measure: string; kind: string; tag: string } => {
  const [measure = '', kind = '', , ...tag] = key.split(':')
  return { measure, kind, tag: tag.join(':') }
}

/** Whether a count's key is `kind` of `measure` whose tag begins with `prefix` and names a skill or agent of this plugin after it. */
const isOwnFork = (key: string, measure: string, kind: string, prefix: string): boolean => {
  const p = partsOf(key)
  return p.measure === measure && p.kind === kind && p.tag.startsWith(prefix) && ownName(p.tag.slice(prefix.length)) !== null
}

export const savingsToday = (ledger: Ledger, now: number): Savings => ({
  digests: sumCounts(ledger, now, 1, k => k.startsWith('A1:fired:')),
  tokens: sumOf(ledger, now, 1, 'A1:savedTokens'),
  milliUsd: sumOf(ledger, now, 1, 'A1:savedMilliUsd'),
  wouldFire: sumCounts(ledger, now, 1, k => k.split(':')[1] === 'would'),
  recovered: sumCounts(ledger, now, 1, k => k.startsWith('A1:outcome:') && (k.endsWith(':rerun') || k.endsWith(':readback'))),
  // Never added to the digest's figures: those are cuts that happened, these are reads the conversation was spared by estimate.
  forks: sumCounts(ledger, now, 1, k => partsOf(k).measure === 'B1' && partsOf(k).kind === 'signal' && partsOf(k).tag.startsWith('kept_')),
  keptTokens: sumOf(ledger, now, 1, 'B1:keptTokens'),
  keptMilliUsd: sumOf(ledger, now, 1, 'B1:keptMilliUsd'),
  forkReaders: sumCounts(ledger, now, 1, k => isOwnFork(k, 'B1', 'signal', 'readers_')),
  forkRereads: sumCounts(ledger, now, 1, k => isOwnFork(k, 'B1', 'outcome', 'reread_')),
  forkCostMilliUsd: sumOf(ledger, now, 1, 'B1:scoutMicroUsd') / 1000,
  forkLosses: sumCounts(ledger, now, 1, k => isOwnFork(k, 'B1', 'outcome', 'lost_')),
  // Cuts made in a subagent's loop: said apart from the digest's, since the conversation would never have read them.
  subCuts: sumCounts(ledger, now, 1, k => partsOf(k).measure === 'A1' && partsOf(k).kind === 'signal' && partsOf(k).tag === 'sub_cut'),
  subTokens: sumOf(ledger, now, 1, 'A1:subSavedTokens'),
  // What the kept-out tokens spared the requests that followed them (lib/core/flow): one event per request that carried less.
  flowReqs: sumCounts(ledger, now, 1, k => k === 'A1:signal:auto:flow'),
  flowTokens: sumOf(ledger, now, 1, 'A1:flowTokens'),
  flowKeptTokens: sumOf(ledger, now, 1, 'A1:flowKeptTokens'),
  flowMicroUsd: sumOf(ledger, now, 1, 'A1:flowMicroUsd'),
})

/** How a kind of suggestion has fared over the last two weeks: made, followed within a few turns, and left unanswered. */
export const NUDGE_RETIRE = { minShown: 20, adoptionBelow: 0.2, ignoredAbove: 0.5 } as const

export const nudgeStats = (ledger: Ledger, now: number, measure: string): { shown: number; accepted: number; ignored: number } => ({
  shown: sumCounts(ledger, now, 14, k => k.startsWith(`${measure}:shown:`)),
  accepted: sumCounts(ledger, now, 14, k => k.startsWith(`${measure}:accepted:suggest`)),
  ignored: sumCounts(ledger, now, 14, k => k.startsWith(`${measure}:dismissed:suggest:ignored`)),
})

/** The kinds of suggestion to stop making: made at least twenty times, followed less than one time in five, and passed over more than half the time. */
export const retiredNudges = (ledger: Ledger, now: number): string[] =>
  ['C1', 'C2', 'C3'].filter(m => {
    const { shown, accepted, ignored } = nudgeStats(ledger, now, m)
    return shown >= NUDGE_RETIRE.minShown && accepted / shown < NUDGE_RETIRE.adoptionBelow && ignored / shown > NUDGE_RETIRE.ignoredAbove
  })

/** The ledger as it is handed over for the pilot: counts and sums by day, with the settings in force and a name for the person that is not theirs. Nothing of the work. */
export const exportLedger = (ledger: Ledger, info: { participant: string; arm: Arm; options: Record<string, unknown>; version: string }): string =>
  JSON.stringify({ v: 1, participant: info.participant, arm: info.arm, version: info.version, options: info.options, days: ledger.days })
