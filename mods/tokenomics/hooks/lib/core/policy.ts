import { fnv1a } from './hash'
import type { CoreOptions, Mode } from './options'

export type Tier = 'A' | 'B' | 'C'
export type MeasureId = 'A1' | 'B1' | 'B2' | 'B3' | 'B6' | 'C1' | 'C2' | 'C3'
/** `control` is the share of people left alone so the rest can be compared with them: it only ever observes. */
export type Arm = 'treat' | 'control'

type Measure = {
  tier: Tier
  label: string
  /** The setting that owns it. */
  option: 'digest' | 'delegation' | 'steer' | 'nudges'
  /** The modes this build has for it. Any other falls back to `observe`; `off` is always honoured. */
  modes: readonly Mode[]
}

/** Every measure the mod has, one row each; the plan (docs/design/tokenomics-redesign.md, section 6) names them. */
export const MEASURES: Record<MeasureId, Measure> = {
  A1: { tier: 'A', label: '出力ダイジェスト', option: 'digest', modes: ['off', 'observe', 'auto'] },
  B1: { tier: 'B', label: 'サブエージェントの格下げ', option: 'delegation', modes: ['off', 'observe', 'auto'] },
  B2: { tier: 'B', label: 'サブエージェントの effort', option: 'delegation', modes: ['off', 'observe', 'auto'] },
  // Replacing Explore with the light scout is watched only, for now.
  B3: { tier: 'B', label: 'Explore の置き換え', option: 'delegation', modes: ['off', 'observe'] },
  // The main conversation's own search or whole test run is turned back once, with the light skill named. The only measure that refuses a call.
  B6: { tier: 'B', label: '調査・テストをスキルへ', option: 'steer', modes: ['off', 'observe', 'auto'] },
  C1: { tier: 'C', label: '話題転換 → /clear', option: 'nudges', modes: ['off', 'observe', 'suggest'] },
  C2: { tier: 'C', label: '文脈肥大 → /compact', option: 'nudges', modes: ['off', 'observe', 'suggest'] },
  C3: { tier: 'C', label: 'キャッシュ切れ', option: 'nudges', modes: ['off', 'observe', 'suggest'] },
}

export const MEASURE_IDS = Object.keys(MEASURES) as MeasureId[]

/**
 * What a measure does now: the setting's word, held to the modes it has, and never more than watching for the held-back arm.
 * The digest keeps its copies in the OS temp folder, which is the person's own only where `TMPDIR` is set (macOS); without a place
 * to keep them (`canSave`) it only watches.
 */
export const modeOf = (id: MeasureId, options: CoreOptions, arm: Arm, canSave = true): Mode => {
  const measure = MEASURES[id]
  const chosen: Mode = options[measure.option]
  if (chosen === 'off') return 'off'
  const mode = measure.modes.includes(chosen) ? chosen : 'observe'
  if (arm === 'control' || (id === 'A1' && mode === 'auto' && !canSave)) return 'observe'
  return mode
}

/** A person's bucket, 0 to 99, from any stable text of theirs. */
export const bucketOf = (seed: string): number => fnv1a(seed) % 100

/** Whether this person is among the `holdoutPercent` who are left alone. The same seed always gives the same answer. */
export const armOf = (seed: string, holdoutPercent: number): Arm => (holdoutPercent > 0 && bucketOf(seed) < holdoutPercent ? 'control' : 'treat')

/** Consecutive failures of each measure's hook; a measure that keeps failing stops for the session instead of failing on. */
export type Breaker = Readonly<Record<string, number>>

export const BREAKER_LIMIT = 3

export const failed = (b: Breaker, id: MeasureId): Breaker => ({ ...b, [id]: (b[id] ?? 0) + 1 })

export const succeeded = (b: Breaker, id: MeasureId): Breaker => (b[id] === undefined || b[id] === 0 ? b : { ...b, [id]: 0 })

export const isTripped = (b: Breaker, id: MeasureId): boolean => (b[id] ?? 0) >= BREAKER_LIMIT
