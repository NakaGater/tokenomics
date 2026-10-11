import type { EffortSetting, Modes } from '../../types'

export const initialModes: Modes = {
  effort: null,
  isWorkerOn: false,
  isHandoffOn: false,
  previousModel: null,
  handoffs: 0,
}

const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

export const EFFORT_LABEL: Record<EffortSetting, string> = { medium: 'ふつう', low: '低め' }

/**
 * The effort a step should go out with, or undefined to leave it be. A cap only
 * ever lowers: a session already at `low` is not raised to `medium`, and an
 * integer budget or a model with no effort is none of this mod's business.
 */
export const cappedEffort = (current: string | number | undefined, cap: EffortSetting | null): EffortSetting | undefined => {
  if (cap === null || typeof current !== 'string') return undefined
  const rank = EFFORT_RANK[current]
  return rank !== undefined && EFFORT_RANK[cap] !== undefined && (EFFORT_RANK[cap] ?? 0) < rank ? cap : undefined
}

/** haiku < sonnet < the rest (opus, fable, the account default). Variants like `sonnet[1m]` count as their family. */
const modelTier = (value: string): number => (value.includes('haiku') ? 0 : value.includes('sonnet') ? 1 : 2)

export const MODEL_LABEL: Record<string, string> = { sonnet: 'Sonnet', haiku: 'Haiku' }

const SWITCH_TARGETS = ['sonnet', 'haiku']

/** The cheaper models the /config row allows, lighter than the one in use. */
export const lighterModels = (current: string, options: readonly string[]): string[] =>
  SWITCH_TARGETS.filter(target => options.includes(target) && modelTier(target) < modelTier(current))

/**
 * A 200k model cannot take a conversation that has outgrown it; the 1M variants can. This
 * refuses only a move from a larger window (`window` over 200k) onto a 200k model with the
 * context past 160k: between two 200k models the engine already keeps the context within it.
 */
export const fitsWindow = (target: string, contextTokens: number | null, window: number | null): boolean =>
  target.includes('[1m]') || (window ?? 0) <= 200_000 || (contextTokens ?? 0) < 160_000

/** One dim line for the band while anything that changes how Claude works is on; null when nothing is. */
export const tagOf = (m: Modes): string | null => {
  const parts: string[] = []
  if (m.effort !== null) parts.push(`effort ${EFFORT_LABEL[m.effort]}`)
  if (m.isWorkerOn) parts.push('軽量エージェント')
  return parts.length === 0 ? null : `節約中: ${parts.join('・')}`
}

export type SavingKey = 'effort' | 'worker' | 'handoff' | 'model'

/** One accepted saving that is still in effect, with the words for the button that ends it. */
export type ActiveSaving = { key: SavingKey; label: string; stop: string }

/** What the person has accepted and is still running, for the pane: nothing to choose from, only to end. */
export const activeSavings = (m: Modes): ActiveSaving[] => [
  ...(m.effort === null ? [] : [{ key: 'effort' as const, label: `考える深さ: ${EFFORT_LABEL[m.effort]}に制限中`, stop: 'やめる' }]),
  ...(m.isWorkerOn ? [{ key: 'worker' as const, label: '軽量エージェント: 使える状態', stop: 'やめる' }] : []),
  ...(m.isHandoffOn ? [{ key: 'handoff' as const, label: '要約の前にメモを残す', stop: 'やめる' }] : []),
  ...(m.previousModel === null ? [] : [{ key: 'model' as const, label: `モデルを切り替え中（元: ${m.previousModel}）`, stop: '元に戻す' }]),
]
