import { modelFamily } from './economics'

/**
 * Subagent types that may be run on a lighter model, by name. A list of what is allowed, never of what is not:
 * an agent's own definition can name a model the spawn does not show, and those are left alone.
 */
export const ALLOWED_TYPES: readonly string[] = ['Explore']

/** A spawn asking for the same thing again within this many turns is the first one not having been enough. */
export const REDELEGATION_TURNS = 3
const SAME_TASK = 0.5

export type SpawnFacts = {
  subagentType: string
  /** The model the spawn names, if it does. */
  model: string | undefined
  parentModel: string
  isFork: boolean
  isTeammate: boolean
  isWorkflow: boolean
}

export type RecentSpawn = { type: string; description: string; turn: number }

export type Why = 'ok' | 'fork' | 'teammate' | 'workflow' | 'explicit' | 'notlisted' | 'parentlight' | 'redelegated'

export type SpawnVerdict = {
  /** The spawn is one the measure may act on. */
  qualifies: boolean
  why: Why
  /** The model alias to run it on instead, when there is a lighter one. */
  target: string | null
}

const bigrams = (text: string): Set<string> => {
  const plain = text.toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < plain.length; i += 1) out.add(plain.slice(i, i + 2))
  return out
}

/** How alike two texts are, 0 to 1: shared pairs of neighbouring characters over all the pairs there are. */
export const similarity = (a: string, b: string): number => {
  const x = bigrams(a)
  const y = bigrams(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const g of x) if (y.has(g)) shared += 1
  return shared / (x.size + y.size - shared)
}

/** The model a spawn would run on instead of its parent's: one step lighter, and only from above Sonnet. */
export const lighterTarget = (parentModel: string): string | null => {
  const family = modelFamily(parentModel)
  return family === 'opus' || family === 'fable' ? 'sonnet' : null
}

/** Whether a spawn may be run lighter, and on what. The first reason a spawn is left alone is the one given. */
export const decideSpawn = (s: SpawnFacts, recent: readonly RecentSpawn[], description: string, turn: number): SpawnVerdict => {
  const no = (why: Why): SpawnVerdict => ({ qualifies: false, why, target: null })
  if (s.isFork) return no('fork')
  if (s.isTeammate) return no('teammate')
  if (s.isWorkflow) return no('workflow')
  if (s.model !== undefined && s.model !== '') return no('explicit')
  if (!ALLOWED_TYPES.includes(s.subagentType)) return no('notlisted')
  const target = lighterTarget(s.parentModel)
  if (target === null) return no('parentlight')
  if (recent.some(r => r.type === s.subagentType && turn - r.turn <= REDELEGATION_TURNS && similarity(r.description, description) >= SAME_TASK)) {
    return no('redelegated')
  }
  return { qualifies: true, why: 'ok', target }
}

const KNOWN_TYPES: readonly string[] = ['Explore', 'Plan', 'general-purpose', 'claude', 'statusline-setup', 'fork', 'teammate']
const OWN_TYPES = /^tokenomics:(?:scout|test-runner|log-digest|light-worker)$/

/**
 * A word safe to keep in the ledger for a subagent type. The names the engine and this plugin give are kept; an agent from another
 * plugin is `plugin` and one a person defined is `custom`, since such a name can carry the name of a project.
 */
export const typeTag = (subagentType: string): string =>
  KNOWN_TYPES.includes(subagentType) || OWN_TYPES.test(subagentType) ? subagentType : subagentType.includes(':') ? 'plugin' : 'custom'
