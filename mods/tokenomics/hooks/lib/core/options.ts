import type { PluginOptions } from 'claude-code'

/** How a group of measures behaves. `suggest` and `auto` only where the measure has such a mode (lib/core/policy.ts). */
export type Mode = 'off' | 'observe' | 'suggest' | 'auto'

/** The mod's settings, as the `/config` menu holds them (plugin.json `userConfig`), after defaults and sanity. */
export type CoreOptions = {
  /** The cat, the band and the pane are drawn (terminal only). The savings below work without them. */
  hud: boolean
  /** A1: big command output is cut down, its full text saved to a file. */
  digest: 'off' | 'observe' | 'auto'
  /** B1 and B2: a subagent runs on a lighter model and thinks less. */
  delegation: 'off' | 'observe' | 'auto'
  /** B6: the main conversation's own search or whole test run is turned back once, with the light skill (scout, test-summary) named. */
  steer: 'off' | 'observe' | 'auto'
  /** C1 to C3: one-line suggestions. `observe` only notes, in the ledger, when one would have been made; `suggest` makes it, after a reply. */
  nudges: 'off' | 'observe' | 'suggest'
  /** Before a conversation is lost (`/clear`, a compaction) a note is written of what it was doing, and the one that goes on is told where it is (one line). */
  handoffNote: boolean
  /** Share of people (0 to 100) who get no intervention at all, so the savings can be measured against them. */
  holdoutPercent: number
  /** How long the prompt cache lives, in minutes; 0 lets the mod tell: five on an API key, sixty on a subscription. */
  cacheTtlMinutes: number
}

export const DEFAULT_OPTIONS: CoreOptions = {
  hud: true,
  digest: 'auto',
  delegation: 'observe',
  steer: 'observe',
  nudges: 'observe',
  handoffNote: true,
  holdoutPercent: 0,
  cacheTtlMinutes: 0,
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const number = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** The options the engine passes to `register`, read defensively: a value that does not fit counts as unset. */
export const parseOptions = (raw: PluginOptions | undefined): CoreOptions => {
  const o: Record<string, unknown> = raw ?? {}
  return {
    hud: typeof o.hud === 'boolean' ? o.hud : DEFAULT_OPTIONS.hud,
    digest: pick(o.digest, ['off', 'observe', 'auto'], DEFAULT_OPTIONS.digest),
    delegation: pick(o.delegation, ['off', 'observe', 'auto'], DEFAULT_OPTIONS.delegation),
    steer: pick(o.steer, ['off', 'observe', 'auto'], DEFAULT_OPTIONS.steer),
    nudges: pick(o.nudges, ['off', 'observe', 'suggest'], DEFAULT_OPTIONS.nudges),
    handoffNote: typeof o.handoffNote === 'boolean' ? o.handoffNote : DEFAULT_OPTIONS.handoffNote,
    holdoutPercent: number(o.holdoutPercent, 0, 100, DEFAULT_OPTIONS.holdoutPercent),
    cacheTtlMinutes: number(o.cacheTtlMinutes, 0, 120, DEFAULT_OPTIONS.cacheTtlMinutes),
  }
}

/** How long a pause may be before the prompt cache is taken to have lapsed, in milliseconds. */
export const cacheTtlMs = (options: CoreOptions, isSubscription: boolean): number =>
  (options.cacheTtlMinutes > 0 ? options.cacheTtlMinutes : isSubscription ? 60 : 5) * 60_000
