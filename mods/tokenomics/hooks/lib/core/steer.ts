/**
 * B6: the main conversation does a search, a whole test run or a read of a long log itself, where a light skill (`scout`,
 * `test-summary`, `log-digest`) would keep the output out of its context. The call is turned back, with a note that names the skill
 * and says how to go on with the same call (that is how the model says it is the exception). A test run or a log is turned back
 * every time; a search waits longer between times the more the model insists. Pure: what the hook remembers lives in
 * `SteerState`, and every step returns the next one.
 */

import { ASSUMED_TURNS_AFTER, PRICES, keptOutUsd, modelFamily } from './economics'

export type SteerKind = 'search' | 'test' | 'log'

/** The Nth search of a turn is the first one turned back: a quick lookup is cheap, an investigation is not. */
export const SEARCH_AT = 2
/** A search is turned back again only this many turns after the last time; it doubles with every time the model insisted. */
export const GAP_TURNS = 3
/** The longest that gap grows to. */
export const MAX_GAP_TURNS = 24
/**
 * The kinds that wait between times. A whole test run and a long log are nearly always long and the exception is seen in the call
 * (a name, a pipe, a limit), so they are turned back every time; a search is often small, so the model's insisting lengthens the wait.
 */
const WAITS: readonly SteerKind[] = ['search']
/** A skill used this soon after a call was turned back counts as the answer to it. */
export const ANSWER_TURNS = 2

export type SteerState = {
  /** Searches the main conversation has made in the running turn. */
  searches: number
  /** What the results of the searches it has read in the running turn held, in tokens, and how many results that sums. */
  searchTokens: number
  searchSeen: number
  /** The main conversation has edited something in the running turn: it is working on what it found, not looking. */
  hasEdited: boolean
  /** The call turned back last, until a skill answers it or it goes unanswered. */
  refused: { kind: SteerKind; key: string; turn: number } | null
  /** The turn each kind was last turned back on. */
  lastAt: Partial<Record<SteerKind, number>>
  /** Kinds the model has insisted on by making the same call again: not turned back again in that turn. */
  insisted: SteerKind[]
  /** How many times the model insisted on each kind this session: the more, the longer before it is asked again. */
  insists: Partial<Record<SteerKind, number>>
}

export const freshSteer = (): SteerState => ({ searches: 0, searchTokens: 0, searchSeen: 0, hasEdited: false, refused: null, lastAt: {}, insisted: [], insists: {} })

/** A new turn begins: its counts start over, and so does what was insisted on (that was about the search in hand); what was refused stays. */
export const steerTurn = (s: SteerState): SteerState => ({ ...s, searches: 0, searchTokens: 0, searchSeen: 0, hasEdited: false, insisted: [] })

/** A search result the model read: what it held, in tokens. */
export const steerSeen = (s: SteerState, tokens: number): SteerState => ({
  ...s,
  searchTokens: s.searchTokens + Math.max(0, Math.round(tokens)),
  searchSeen: s.searchSeen + 1,
})

/**
 * What handing the rest of an investigation to the scout costs, apart from what it reads: the report that comes back stays in the
 * conversation, the scout's own run, and the model writing the question. Measured on this plugin's scout (2026-10-12): a run is
 * $0.0008-0.0026 at list prices, the report 400-800 tokens (the agent is asked to keep it short). Output is priced as 5x input.
 */
export const REPORT_TOKENS = 450
export const SCOUT_RUN_USD = 0.002
const ASK_OUTPUT_TOKENS = 150
const OUTPUT_TO_INPUT = 5
/** Searches still to come in the turn that handing over now would spare: the guess is two. */
const MORE_SEARCHES = 2

/**
 * Whether turning a search back pays. What the model has read from its searches this turn says what the next ones will bring; kept
 * out of the conversation it is worth its price over the turns that follow (written once, read every turn), against what the
 * hand-over costs. A request avoided is left out of this on purpose: a call turned back that the model repeats wastes one request,
 * and a hand-over that is taken saves one, so at an even chance they cancel. With nothing measured there is no reason to hold back.
 */
export const delegationPays = (s: SteerState, model: string | undefined): boolean => {
  if (s.searchSeen === 0) return true
  const family = modelFamily(model) ?? 'sonnet'
  const further = (s.searchTokens / s.searchSeen) * MORE_SEARCHES
  const worth = keptOutUsd(further, family, ASSUMED_TURNS_AFTER) ?? 0
  const overhead =
    (keptOutUsd(REPORT_TOKENS, family, ASSUMED_TURNS_AFTER) ?? 0) + SCOUT_RUN_USD + (ASK_OUTPUT_TOKENS * OUTPUT_TO_INPUT * PRICES[family].input) / 1_000_000

  return worth >= overhead
}

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

/**
 * Whether a command line searches. A line is often several commands (`S=/x; echo ---; grep ...`, `sed -n 1,5p f; grep ...`,
 * `for f in a b; do grep ...; done`), so any command of it counts, not only the first: measured on this machine the first-command
 * rule saw 57 of the 142 searching lines of one session. A search at the end of a pipe is not one (`ls | grep x` lists).
 */
const isSearch = (command: string): boolean =>
  segments(command).some(raw => {
    const segment = raw.replace(/^(?:do|then|else|elif|\{|\()\s+/, '')
    const word = segment.split(/\s+/)[0] ?? ''
    if (segment.startsWith('git grep')) return true
    if (!SEARCHERS.has(word)) return false

    // `find` that changes things is not looking.
    return !(word === 'find' && /\s-(?:delete|exec|execdir|ok)\b/.test(segment))
  })

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

/** A log printed with a limit of this many lines or fewer is small enough to read directly. */
export const SMALL_LOG_LINES = 200

/** A flag that follows the log as it grows (a short flag among others too: `-fu`): that is watching, not reading. */
const FOLLOWS = /\s(?:--follow|-[A-Za-z]*f[A-Za-z]*)(?=\s|$)/

/** The line count a log command limits itself to (`--tail 50`, `--tail=50`, `-n 50`, `--lines=50`), or null where it has none. */
const limitedTo = (line: string): number | null => {
  const m = /(?:^|\s)(?:--tail|--lines|-n)(?:\s*=\s*|\s+|(?=\d))(\d+)(?=\s|$)/.exec(line)

  return m?.[1] === undefined ? null : Number(m[1])
}

/**
 * Whether a command prints a log that can be long, all of it: the commands whose job is that (`docker logs`, `kubectl logs`,
 * `journalctl`, a CI run's `--log`), or `cat` and a pager on a `*.log` file. A limit of a few lines, following the log as it grows,
 * a pipe and a redirect make it something else: the caller already narrows what comes back. A list of kinds, not of every command
 * that can print a log: what is not on it is not turned back.
 */
const isLogRead = (command: string): boolean => {
  const only = segments(command).filter(s => !/^cd(?:\s|$)/.test(s))
  if (only.length !== 1) return false
  const line = (only[0] ?? '').replace(/\s*2>&1/g, '')
  if (/[|<>]/.test(line)) return false

  if (/^(?:docker(?:\s+compose)?|docker-compose|podman(?:\s+compose)?)\s+logs\b/.test(line) || /^kubectl\b.*\slogs\b/.test(line) || /^journalctl\b/.test(line)) {
    if (FOLLOWS.test(line)) return false
    const limit = limitedTo(line)

    return limit === null || limit > SMALL_LOG_LINES
  }
  if (/^gh\s+run\s+view\b/.test(line)) return /\s--log(?:-failed)?(?=\s|$)/.test(line)
  if (/^(?:cat|less|more|bat)\b/.test(line)) {
    return line
      .split(/\s+/)
      .slice(1)
      .some(w => /\.log(?:\.\d+)?$/.test(w.replace(/^['"]|['"]$/g, '')))
  }

  return false
}

/** Where a command may write without touching the work: the null device and scratch space. */
const SCRATCH = /^(?:\/dev\/|\/tmp\/|\/private\/(?:tmp|var)\/|\/var\/folders\/|\$\{?TMPDIR\}?\/)/

/** The command without the bodies of its here-documents: the lines that are the shell's own. */
const withoutHeredocs = (command: string): string => {
  const kept: string[] = []
  let end: string | null = null
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    kept.push(line)
    const m = /<<-?[ \t]*(['"]?)(\w+)\1/.exec(line)
    if (m !== null && m[2] !== undefined && line[m.index - 1] !== '<') end = m[2]
  }

  return kept.join('\n')
}

/** What a shell variable the command sets itself stands for (`S=/private/tmp/x`), to see where a redirect goes. */
const assignments = (shell: string): Map<string, string> => {
  const vars = new Map<string, string>()
  for (const m of shell.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=([^\s;&|]+)/g)) {
    if (m[1] !== undefined && m[2] !== undefined && !vars.has(m[1])) vars.set(m[1], m[2].replace(/^['"]|['"]$/g, ''))
  }

  return vars
}

/** Whether a path a command writes to is scratch. A shell variable that is not set in the command is taken for a log's folder. */
const isScratch = (path: string, vars: Map<string, string>): boolean => {
  const clean = path.replace(/^['"]|['"]$/g, '')
  const expanded = clean.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole)

  return SCRATCH.test(expanded) || /^\$\{?\w+\}?(?:\/|$)/.test(expanded)
}

/** The files a script (Python, Node) opens for writing: the path as written, or null where it cannot be told. */
const scriptWrites = (text: string): Array<string | null> => {
  const named = (id: string): string | null => new RegExp(`\\b${id}\\s*=\\s*[fFrR]*(['"])(.*?)\\1`).exec(text)?.[2] ?? null
  const out: Array<string | null> = []
  for (const m of text.matchAll(/\bopen\(\s*(?:[fFrRbB]*(['"])(.*?)\1|([A-Za-z_]\w*))\s*,\s*(?:mode\s*=\s*)?['"][wax][bt+]*['"]/g)) {
    out.push(m[2] ?? (m[3] === undefined ? null : named(m[3])))
  }
  for (const m of text.matchAll(/\bPath\(\s*(?:[fFrR]*(['"])(.*?)\1|([A-Za-z_]\w*))\s*\)\s*\.write_(?:text|bytes)\(/g)) {
    out.push(m[2] ?? (m[3] === undefined ? null : named(m[3])))
  }
  if (!/\bPath\(/.test(text) && /\.write_(?:text|bytes)\(/.test(text)) out.push(null)
  for (const m of text.matchAll(/\b(?:writeFile|appendFile)(?:Sync)?\(\s*(?:(['"`])(.*?)\1|([A-Za-z_]\w*))/g)) {
    out.push(m[2] ?? (m[3] === undefined ? null : named(m[3])))
  }

  return out
}

/**
 * Whether a shell command changes the work, which a model does as much through the shell as through the edit tools: an in-place
 * `sed` or `perl`, `git apply`, `patch`, a redirect or `tee` into a file, a script that opens one for writing. Writes to scratch
 * space (a log under /tmp, /dev/null) are not changes to the work, and neither is a redirect of the error stream alone.
 */
export const isBashEdit = (command: string): boolean => {
  const shell = withoutHeredocs(command)
    // A quoted word right after `>`, `>>` or `tee` is a path, not text: it stays. Other quoted text is taken out.
    .replace(/(>>?[ \t]*|\btee[ \t]+(?:-[a-zA-Z]+[ \t]+)*)(["'])([^\s"']*)\2/g, '$1$3')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
  const vars = assignments(shell)
  const inTree = (path: string | null): boolean => path === null || !isScratch(path, vars)

  if (/\bsed\b[^|;&\n]*?\s-(?:[a-zA-Z]*i[a-zA-Z.]*|-in-place\S*)(?:\s|$)/.test(shell)) return true
  if (/\bperl\b[^|;&\n]*?\s-[a-zA-Z]*i[a-zA-Z.]*(?:\s|$)/.test(shell)) return true
  if (/\bgit\s+apply\b/.test(shell) || /(?:^|[\s;&|])patch\s/.test(shell)) return true

  for (const m of shell.matchAll(/(\S*?)>>?[ \t]*([^\s;|&<>()]*)/g)) {
    const before = m[1] ?? ''
    const target = m[2] ?? ''
    // `2>&1` has no target; `2>log` and `&>log` are the error stream's.
    if (target === '' || before.endsWith('&') || /^[02-9]$/.test(before)) continue
    if (inTree(target)) return true
  }
  for (const m of shell.matchAll(/\btee\s+(?:-[a-zA-Z]+\s+)*([^\s;|&<>()]+)/g)) if (inTree(m[1] ?? null)) return true

  return scriptWrites(command).some(inTree)
}

/** What a tool call is, for this measure: a search, a whole-suite test run or a read of a long log, or none of them. */
export const callKind = (tool: string, input: Record<string, unknown>): SteerKind | null => {
  if (tool === 'Grep' || tool === 'Glob') return 'search'
  if (tool !== 'Bash' || typeof input.command !== 'string') return null
  if (isSuiteRun(input.command)) return 'test'
  if (isLogRead(input.command)) return 'log'

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
 * call is never really turned back, so a repeat of it is no insistence. `model` is the conversation's, to price what a hand-over
 * would spare.
 */
export const steerStep = (s: SteerState, tool: string, input: Record<string, unknown>, turn: number, isDry = false, model?: string): SteerVerdict => {
  // A change to the work, through an edit tool or through the shell.
  if (EDITS.includes(tool) || (tool === 'Bash' && typeof input.command === 'string' && isBashEdit(input.command))) {
    return { say: 'pass', next: { ...s, hasEdited: true } }
  }
  const kind = callKind(tool, input)
  if (kind === null) return { say: 'pass', next: s }

  const key = callKey(tool, input)
  const counted = kind === 'search' ? { ...s, searches: s.searches + 1 } : s
  if (!isDry && s.refused !== null && s.refused.key === key && turn - s.refused.turn <= ANSWER_TURNS) {
    const insisted = counted.insisted.includes(kind) ? counted.insisted : [...counted.insisted, kind]
    const insists = { ...counted.insists, [kind]: (counted.insists[kind] ?? 0) + 1 }
    return { say: 'insist', kind, next: { ...counted, refused: null, insisted, insists } }
  }
  // Only watching, the repeat of a call that would have been turned back is the model going on, as insisting would be: not a new case.
  if (isDry && s.refused !== null && s.refused.key === key && turn - s.refused.turn <= ANSWER_TURNS) return { say: 'pass', next: counted }
  if (counted.insisted.includes(kind)) return { say: 'pass', next: counted }
  if (kind === 'search' && (counted.searches < SEARCH_AT || counted.hasEdited || !delegationPays(counted, model))) return { say: 'pass', next: counted }
  const last = counted.lastAt[kind]
  // Every time the model insisted on a search, the wait before it is asked again doubles. The other kinds do not wait.
  const gap = WAITS.includes(kind) ? Math.min(MAX_GAP_TURNS, GAP_TURNS * 2 ** (counted.insists[kind] ?? 0)) : 0
  if (last !== undefined && turn - last < gap) return { say: 'pass', next: counted }

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

/**
 * The note the model reads in place of the result. English, as the model's other instructions from this plugin are. `contextTokens`
 * is the conversation's size, so that the model knows what each further search costs it.
 */
export const steerNote = (kind: SteerKind, searches: number, contextTokens: number | null = null): string => {
  if (kind === 'log') {
    return 'tokenomics: this prints a log that can be long, and it was not run. If you only need to know what went wrong, call the Skill tool with skill "tokenomics:log-digest" (args: the same command, or the path of the log file): a cheap agent reads it and returns the errors and their cause in a few lines. If you need the full text, make this same call again and it will run.'
  }
  if (kind === 'test') {
    return 'tokenomics: this runs the whole test suite, and it was not run. If you only need to know what failed, call the Skill tool with skill "tokenomics:test-summary" (args: the command, or nothing for the usual one): a cheap agent runs it and returns only the failures. If you need the full output, make this same call again and it will run.'
  }
  const size =
    contextTokens === null || contextTokens < 1000
      ? ''
      : ` Every search is another request that sends the whole conversation (about ${Math.round(contextTokens / 1000)}k tokens) again; the scout works in its own small context on a cheap model.`

  return `tokenomics: this is search number ${searches} in this turn, and it was not run.${size} If you are investigating (finding where something is defined or used, or how a part of the code works), call the Skill tool with skill "tokenomics:scout" and the question as args: a cheap agent does the searching and returns a short report with file paths, so the files stay out of your context. If you need these results yourself (you are about to edit this code, or need the exact text), make this same call again and it will run.`
}
