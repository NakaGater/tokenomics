/**
 * What the plugin's light skills and agents keep out of the main conversation. A subagent's tool results never reach the
 * conversation, only its report does; what its tool results held, less the report, is what the conversation would have read had
 * it done the work itself. It is a floor, not a count: the model's own searching also costs what it says between the calls, and
 * the figure leaves that out. Pure: the hook remembers one `ForkRun` per subagent and every step returns the next.
 */

export type ForkRun = {
  /** Tokens the subagent's tool results held, as the model of the subagent read them. */
  readTokens: number
  /** Set when its turn ended; the run is settled once it ended and its kind is known. */
  ended?: {
    /** Tokens of the report it handed back. */
    reportTokens: number
    /** What the turn spent (null when the engine gave no usage). */
    spent: number | null
    /** Whether it read any file: for the check on the conversation reading the same files again. */
    isReader: boolean
    /** The main conversation's turn it ended in. */
    turn: number
    /** What the run itself cost on the input side, in millionths of a dollar at list prices (null when not known): a run costs a few thousandths. */
    microUsd?: number | null
  }
}

/** Runs remembered at once; the oldest is forgotten past this. */
export const MAX_FORKS = 24

/** What a run kept out of the conversation, once its kind is known. */
export type ForkOutcome = {
  name: string
  readTokens: number
  reportTokens: number
  keptTokens: number
  /** What the run itself cost (millionths of a dollar, input side), or null. */
  runMicroUsd: number | null
  /** The report was as large as what the run read: nothing was kept out, and the run was paid for. */
  isLoss: boolean
}

const SKILLS: readonly string[] = ['scout', 'test-summary', 'log-digest']
const AGENTS = /^tokenomics:(?:scout|test-runner|log-digest)$/

/** The kind tag a subagent that a skill of this plugin forked is known by. */
export const forkType = (skill: string): string => `fork_${skill}`

/**
 * The skill or agent of this plugin a subagent kind stands for (`fork_scout`, `tokenomics:test-runner`), or null for any other:
 * the engine's own agents, a person's, and this plugin's general worker, which does more than look.
 */
export const ownName = (type: string): string | null => {
  if (type.startsWith('fork_')) {
    const skill = type.slice('fork_'.length)
    return SKILLS.includes(skill) ? skill : null
  }
  return AGENTS.test(type) ? type.slice('tokenomics:'.length) : null
}

/** The id of the subagent a forked skill ran in, from the skill tool's answer; null when it did not fork. */
export const forkedId = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null
  const r = result as Record<string, unknown>
  return r.status === 'forked' && typeof r.agentId === 'string' && r.agentId !== '' ? r.agentId : null
}

const blank: ForkRun = { readTokens: 0 }

/** The run with a tool result of this many tokens added. */
export const forkRead = (run: ForkRun | undefined, tokens: number): ForkRun => ({
  ...(run ?? blank),
  readTokens: (run?.readTokens ?? 0) + Math.max(0, Math.round(tokens)),
})

/** The run with its end noted. */
export const forkEnded = (
  run: ForkRun | undefined,
  ended: { reportTokens: number; spent: number | null; isReader: boolean; turn: number; microUsd?: number | null },
): ForkRun => ({
  ...(run ?? blank),
  ended: { ...ended, reportTokens: Math.max(0, Math.round(ended.reportTokens)) },
})

/** The runs with one set, the oldest forgotten past the limit. */
export const forkSet = (runs: ReadonlyMap<string, ForkRun>, id: string, run: ForkRun): Map<string, ForkRun> => {
  const next = new Map(runs)
  next.delete(id)
  next.set(id, run)
  while (next.size > MAX_FORKS) {
    const oldest = next.keys().next()
    if (oldest.done === true) break
    next.delete(oldest.value)
  }
  return next
}

/** What the run kept out of the conversation, when it is a skill or agent of this plugin and has ended; null otherwise. */
export const forkOutcome = (run: ForkRun, type: string): ForkOutcome | null => {
  const name = ownName(type)
  if (name === null || run.ended === undefined) return null
  const keptTokens = Math.max(0, run.readTokens - run.ended.reportTokens)

  return {
    name,
    readTokens: run.readTokens,
    reportTokens: run.ended.reportTokens,
    keptTokens,
    runMicroUsd: run.ended.microUsd ?? null,
    isLoss: run.ended.reportTokens >= run.readTokens,
  }
}
