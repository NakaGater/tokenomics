import type { SessionMessage } from 'claude-code'

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

/** What a note may hold: a few thousand tokens, so reading it back stays cheap. */
const MAX_CHARS = 12_000

/** Why a note is written: it names itself so a reader knows what it stands in for. */
export type HandoffKind = 'compaction' | 'clear' | 'fresh'

const HEADS: Record<HandoffKind, { title: string; lead: (when: string) => string }> = {
  compaction: { title: '# Work notes saved before compaction', lead: when => `Saved ${when}. The summary may have dropped detail; this has the raw facts.` },
  clear: { title: '# Work notes saved before /clear', lead: when => `Saved ${when}, when the conversation was cleared. This has the raw facts of what it was doing; it is not a summary.` },
  fresh: { title: '# Work notes saved before a fresh start', lead: when => `Saved ${when}, for a conversation that starts afresh. This has the raw facts of what this one was doing.` },
}

const clip = (text: string, max: number): string => {
  const one = text.trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

const pathOf = (input: Record<string, unknown>): string | undefined => {
  const value = input.file_path ?? input.notebook_path
  return typeof value === 'string' && value !== '' ? value : undefined
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)]

/** What the harness puts in the person's turn without their writing it: notices, command echoes, a carried-over summary. */
const NOT_A_REQUEST =
  /^(?:<(?:task-notification|local-command-caveat|local-command-stdout|command-name)\b|\[Request interrupted by user|This session is being continued from a previous conversation|\[Image: [^\]]*\]$)/

/** A file in a temp folder: probes and scratch output, not the work itself. */
const isTemp = (path: string): boolean => /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)\//.test(path)

/** The scratch files listed at most, so they never crowd out the work. */
const SCRATCH_MAX = 10

/** The person's requests listed at most; with more, the first one is kept apart because it usually says what the work is. */
const REQUESTS_MAX = 8

/** A summary carried over from an earlier compaction: its head holds the goal and what was pending. */
const CONTINUED = /^This session is being continued from a previous conversation/
const CARRIED_MAX = 1_500
const ANSWER_MAX = 2_500

/** Commands that only look: a note is for what was done, so these are left out of it. */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'echo', 'printf', 'pwd', 'cd', 'cut', 'sort', 'uniq', 'tr', 'file', 'stat', 'which',
  'tree', 'diff', 'test', 'true', 'date', 'basename', 'dirname', 'realpath', 'du', 'df', 'sleep', 'column', 'nl', 'less', 'more',
])
/** `find` looks, unless it is told to delete, run something or write a listing. */
const FIND_DOES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'describe', 'grep'])

const section = (title: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [`## ${title}`, ...lines, '']

const isReadOnlyPart = (part: string): boolean => {
  const words = part.replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)
  const word = words[0] ?? ''
  if (word === '') return true
  if (word === 'sed') return words.includes('-n') && !words.some(w => /^-[a-zA-Z]*i/.test(w))
  if (word === 'git') return READ_ONLY_GIT.has(words[1] ?? '')
  if (word === 'find') return !words.some(w => FIND_DOES.has(w))
  return READ_ONLY.has(word)
}

/** A line that only reads: every command in it is a looker and nothing is redirected into a file. */
const isReadOnlyLine = (line: string): boolean => {
  const bare = line.replace(/\d*>&\d+/g, '').replace(/\d*>>?\s*\/dev\/null/g, '')
  return !bare.includes('>') && bare.split(/&&|\|\||;|\|/).every(part => isReadOnlyPart(part.trim()))
}

/** The first line of a command that did something (a heredoc's opening line counts), or nothing when it only looked. */
const doingLine = (command: string): string | undefined =>
  command
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '' && !l.startsWith('#') && !isReadOnlyLine(l))

/** Real requests only: not the harness's notices, nor a summary carried over from an earlier compaction. */
const isRequest = (m: SessionMessage): boolean => m.role === 'user' && m.text.trim() !== '' && !NOT_A_REQUEST.test(m.text.trim())

/** The carried-over summary's own words, without the harness's lead-in sentence. */
const afterLeadIn = (text: string): string => {
  const at = text.indexOf('Summary:')
  return at >= 0 && at < 600 ? text.slice(at + 'Summary:'.length) : text
}

/**
 * Whether a conversation has anything worth a note: a request of the person's (or a summary carried over from an
 * earlier compaction, which is how a long task goes on after an auto-compaction), and a reply to it.
 */
export const hasWork = (messages: readonly SessionMessage[]): boolean =>
  messages.some(m => isRequest(m) || (m.role === 'user' && CONTINUED.test(m.text.trim()))) && messages.some(m => m.role === 'assistant')

/**
 * What a compaction or a `/clear` would lose, kept from the transcript by rule: the person's
 * requests, the last answer, the files touched, the commands that did something and the
 * scratch files. No model is asked, so writing it costs no tokens. Most useful first, because
 * a note over the limit is cut from its end.
 */
export const buildHandoff = (messages: readonly SessionMessage[], when: string, kind: HandoffKind = 'compaction'): string => {
  const calls = messages.flatMap(m => m.toolUses)
  const all = messages.filter(isRequest)
  const requests = all.slice(-REQUESTS_MAX)
  const first = all.length > REQUESTS_MAX ? all[0] : undefined
  const carried = messages.find(m => m.role === 'user' && CONTINUED.test(m.text.trim()))
  const carriedText = carried === undefined ? '' : afterLeadIn(carried.text)
  const touched = calls.filter(c => EDIT_TOOLS.includes(c.tool) || c.tool === 'Read').flatMap(c => pathOf(c.input) ?? [])
  const scratch = unique(touched.filter(isTemp)).slice(-SCRATCH_MAX)
  const edited = unique(calls.filter(c => EDIT_TOOLS.includes(c.tool)).flatMap(c => pathOf(c.input) ?? [])).filter(p => !isTemp(p))
  const read = unique(calls.filter(c => c.tool === 'Read').flatMap(c => pathOf(c.input) ?? [])).filter(p => !edited.includes(p) && !isTemp(p))
  const commands = calls
    .filter(c => c.tool === 'Bash' && typeof c.input.command === 'string')
    .flatMap(c => {
      const line = doingLine(String(c.input.command))
      return line === undefined ? [] : [`${clip(line, 140)}${c.isError === true ? ' (failed)' : ''}`]
    })
    .filter((line, i, lines) => line !== lines[i - 1])
    .slice(-20)
  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
  const head = HEADS[kind]

  const lines = [
    head.title,
    head.lead(when),
    '',
    ...section('Carried-over summary of the earlier conversation (its head)', carriedText.trim() === '' ? [] : clip(carriedText, CARRIED_MAX).split('\n')),
    ...section('First request', first === undefined ? [] : [`- ${clip(first.text, 600).replace(/\n+/g, ' ')}`]),
    ...section('Recent requests (oldest first)', requests.map(m => `- ${clip(m.text, 400).replace(/\n+/g, ' ')}`)),
    ...section('Last answer', lastAnswer === undefined ? [] : [clip(lastAnswer.text, ANSWER_MAX)]),
    ...section('Files edited or written', edited.slice(-40).map(p => `- ${p}`)),
    ...section('Commands run, reads and searches left out (latest 20)', commands.map(c => `- ${c}`)),
    ...section('Files read', read.slice(-40).map(p => `- ${p}`)),
    ...section(`Scratch files in temp folders, written or read (latest ${SCRATCH_MAX})`, scratch.map(p => `- ${p}`)),
  ]
  return clip(lines.join('\n'), MAX_CHARS)
}

/** Where the working tree stands, from `git status --short --branch`: the branch first, then what changed. */
const GIT_LINES = 40
export const formatGit = (stdout: string): string[] => {
  const lines = stdout.split('\n').map(l => l.trimEnd()).filter(l => l !== '')
  // Not `clip`: it trims, and the first two columns of a status line say staged or not.
  const fit = (l: string): string => (l.length <= 160 ? l : `${l.slice(0, 159)}…`)
  const shown = lines.slice(0, GIT_LINES).map((l, i) => fit(i === 0 && l.startsWith('## ') ? `branch: ${l.slice(3)}` : l))
  return lines.length > GIT_LINES ? [...shown, `… and ${lines.length - GIT_LINES} more`] : shown
}

/** The working tree's state put into a finished note, ahead of the lists of files and commands. */
export const withGit = (note: string, git: readonly string[]): string => {
  if (git.length === 0) return note
  const block = ['## Git state when saved (git status --short --branch)', ...git, ''].join('\n')
  const at = ['## Files edited', '## Commands', '## Files read', '## Scratch'].map(h => note.indexOf(`\n${h}`)).filter(i => i >= 0)
  if (at.length === 0) return `${note.trimEnd()}\n\n${block}`
  const i = Math.min(...at) + 1
  return `${note.slice(0, i)}${block}\n${note.slice(i)}`
}

export const handoffDir = (tmp: string | undefined, sessionId: string): string => {
  const base = (tmp === undefined || tmp === '' ? '/tmp' : tmp).replace(/\/+$/, '')
  return `${base}/claude-tokenomics/${sessionId}`
}

/** A precomputed summary may be used later in place of a fresh one, so it gets a note of its own. */
export const handoffPath = (dir: string, n: number | 'pre'): string => `${dir}/handoff-${n}.md`

/** Asks the summarizer to carry the note's location into the summary, on one line, after what the person asked for. */
export const withPointer = (instructions: string | undefined, path: string): string => {
  const line = `End the summary with one line: "Details: ${path}". Requests, edited files and commands are saved there; read it only if the summary lacks something.`
  return instructions === undefined || instructions.trim() === '' ? line : `${instructions}\n${line}`
}

/** One line for the conversation that goes on after a compaction: the summary is the record, the note only fills a gap in it. */
export const compactPointer = (path: string): string =>
  `Raw notes from before this conversation was compacted (requests, edited files, commands, git state) are saved in ${path}. The summary is the main record; read the notes only if it lacks a detail you need.`

/** One line for the conversation that follows a `/clear`: where the note is, to be read only if the work is to be carried on. */
export const clearPointer = (path: string): string =>
  `Notes from the conversation the person just cleared are saved in ${path}. Read them only if the person asks you to carry on that earlier work; otherwise ignore this line.`
