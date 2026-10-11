/**
 * B6: the main conversation does a search or a whole test run itself, where a light skill (`scout`, `test-summary`) would keep
 * the output out of its context. The call is turned back once, with a note that names the skill and says how to go on with
 * the same call. Pure: what the hook remembers lives in `SteerState`, and every step returns the next one.
 */

export type SteerKind = 'search' | 'test'

/** The Nth search of a turn is the first one turned back: a quick lookup or two is cheap, an investigation is not. */
export const SEARCH_AT = 3
/** A kind is turned back again only this many turns after the last time. */
export const GAP_TURNS = 3
/** A skill used this soon after a call was turned back counts as the answer to it. */
export const ANSWER_TURNS = 2

export type SteerState = {
  /** Searches the main conversation has made in the running turn. */
  searches: number
  /** The main conversation has edited something in the running turn: it is working on what it found, not looking. */
  hasEdited: boolean
  /** The call turned back last, until a skill answers it or it goes unanswered. */
  refused: { kind: SteerKind; key: string; turn: number } | null
  /** The turn each kind was last turned back on. */
  lastAt: Partial<Record<SteerKind, number>>
  /** Kinds the model has insisted on by making the same call again: not turned back again this session. */
  insisted: SteerKind[]
}

export const freshSteer = (): SteerState => ({ searches: 0, hasEdited: false, refused: null, lastAt: {}, insisted: [] })

/** A new turn begins: its counts start over; what was refused and what was insisted on stays. */
export const steerTurn = (s: SteerState): SteerState => ({ ...s, searches: 0, hasEdited: false })

const EDITS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const LIGHT_SKILLS: readonly string[] = ['scout', 'test-summary', 'log-digest']
const LIGHT_AGENTS: readonly string[] = ['scout', 'test-runner', 'log-digest']

/** The light skill or agent of this plugin a call names (`Skill` with `skill`, `Agent` with `subagent_type`), without the plugin's name. */
export const lightUse = (tool: string, input: Record<string, unknown>): string | null => {
  const named = tool === 'Skill' ? input.skill : tool === 'Agent' ? input.subagent_type : undefined
  if (typeof named !== 'string') return null
  // The model may name a skill with or without the plugin in front of it.
  const bare = named.startsWith('tokenomics:') ? named.slice('tokenomics:'.length) : tool === 'Skill' ? named : ''

  return (tool === 'Skill' ? LIGHT_SKILLS : LIGHT_AGENTS).includes(bare) ? bare : null
}

const ENV = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'find'])

/** The commands of a line, split where one ends and the next begins; a pipe is not a split, the line is one command. */
const segments = (command: string): string[] =>
  command
    .split(/&&|\|\||;/)
    .map(s => s.trim().replace(ENV, ''))
    .filter(s => s !== '')

const isSearch = (command: string): boolean => {
  const first = segments(command).find(s => !/^cd(?:\s|$)/.test(s))
  if (first === undefined) return false
  const word = first.split(/\s+/)[0] ?? ''
  if (first.startsWith('git grep')) return true
  if (!SEARCHERS.has(word)) return false

  // `find` that changes things is not looking.
  return !(word === 'find' && /\s-(?:delete|exec|execdir|ok)\b/.test(first))
}

// Runners that run everything when given nothing: only flags may follow.
const SUITES: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)(?: run)? test$/,
  /^(?:npx |bunx |pnpm exec |yarn )?(?:jest|vitest|mocha|playwright test)$/,
  /^(?:python3? -m )?pytest$/,
  /^(?:python3? -m )?unittest(?: discover)?$/,
  /^go test (?:\.\/\.\.\.|\.\.\.)$/,
  /^cargo test$/,
  /^swift test$/,
  /^dotnet test$/,
  /^(?:bundle exec )?(?:rspec|rake test)$/,
  /^make test$/,
  /^(?:\.\/)?(?:mvnw?|gradlew?)(?: -\S+)* test$/,
]

/** `2>&1` and trailing bare flags (and a lone `--`) are not a filter; anything else after the runner (a path, a name, a value) is. */
const isSuiteRun = (command: string): boolean => {
  const first = segments(command).filter(s => !/^cd(?:\s|$)/.test(s))
  if (first.length !== 1) return false
  // A pipe or a redirect to a file means the caller already limits what comes back.
  const line = (first[0] ?? '').replace(/\s*2>&1/g, '')
  if (/[|<>]/.test(line)) return false
  const words = line.split(/\s+/)
  while (words.length > 1 && /^--?(?:[A-Za-z][\w-]*)?$/.test(words[words.length - 1] ?? '')) words.pop()

  return SUITES.some(r => r.test(words.join(' ')))
}

/** What a tool call is, for this measure: a search or a whole-suite test run, or neither. */
export const callKind = (tool: string, input: Record<string, unknown>): SteerKind | null => {
  if (tool === 'Grep' || tool === 'Glob') return 'search'
  if (tool !== 'Bash' || typeof input.command !== 'string') return null
  if (isSuiteRun(input.command)) return 'test'

  return isSearch(input.command) ? 'search' : null
}

/** The same call made again has the same key. */
export const callKey = (tool: string, input: Record<string, unknown>): string => {
  const text = tool === 'Bash' ? input.command : JSON.stringify(input)
  return `${tool}:${typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : ''}`
}

export type SteerVerdict =
  /** Let it run. */
  | { say: 'pass'; next: SteerState }
  /** Turn it back. */
  | { say: 'refuse'; kind: SteerKind; searches: number; next: SteerState }
  /** The model made a refused call again: it wants it, and it runs. */
  | { say: 'insist'; kind: SteerKind; next: SteerState }

/**
 * One main-conversation tool call, in the order they come. A subagent's calls never reach here. When only watching (`isDry`) the
 * call is never really turned back, so a repeat of it is no insistence.
 */
export const steerStep = (s: SteerState, tool: string, input: Record<string, unknown>, turn: number, isDry = false): SteerVerdict => {
  if (EDITS.includes(tool)) return { say: 'pass', next: { ...s, hasEdited: true } }
  const kind = callKind(tool, input)
  if (kind === null) return { say: 'pass', next: s }

  const key = callKey(tool, input)
  const counted = kind === 'search' ? { ...s, searches: s.searches + 1 } : s
  if (!isDry && s.refused !== null && s.refused.key === key && turn - s.refused.turn <= ANSWER_TURNS) {
    const insisted = counted.insisted.includes(kind) ? counted.insisted : [...counted.insisted, kind]
    return { say: 'insist', kind, next: { ...counted, refused: null, insisted } }
  }
  if (counted.insisted.includes(kind)) return { say: 'pass', next: counted }
  if (kind === 'search' && (counted.searches < SEARCH_AT || counted.hasEdited)) return { say: 'pass', next: counted }
  const last = counted.lastAt[kind]
  if (last !== undefined && turn - last < GAP_TURNS) return { say: 'pass', next: counted }

  return {
    say: 'refuse',
    kind,
    searches: counted.searches,
    next: { ...counted, refused: { kind, key, turn }, lastAt: { ...counted.lastAt, [kind]: turn } },
  }
}

/** A skill of this plugin was used: whether it answers a call turned back lately, and the state without that call. */
export const steerAnswered = (s: SteerState, turn: number): { next: SteerState; kind: SteerKind | null } =>
  s.refused !== null && turn - s.refused.turn <= ANSWER_TURNS ? { next: { ...s, refused: null }, kind: s.refused.kind } : { next: s, kind: null }

/** The note the model reads in place of the result. English, as the model's other instructions from this plugin are. */
export const steerNote = (kind: SteerKind, searches: number): string =>
  kind === 'search'
    ? `tokenomics: this is search number ${searches} in this turn, and it was not run. If you are investigating (finding where something is defined or used, or how a part of the code works), call the Skill tool with skill "tokenomics:scout" and the question as args: a cheap agent does the searching and returns a short report with file paths, so the files stay out of your context. If you need these results yourself (you are about to edit this code, or need the exact text), make this same call again and it will run.`
    : 'tokenomics: this runs the whole test suite, and it was not run. If you only need to know what failed, call the Skill tool with skill "tokenomics:test-summary" (args: the command, or nothing for the usual one): a cheap agent runs it and returns only the failures. If you need the full output, make this same call again and it will run.'
