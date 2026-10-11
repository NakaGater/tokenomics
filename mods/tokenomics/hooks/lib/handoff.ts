import type { SessionMessage } from 'claude-code'

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

/** What a note may hold: a few thousand tokens, so reading it back stays cheap. */
const MAX_CHARS = 12_000

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

const section = (title: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [`## ${title}`, ...lines, '']

/**
 * What a compaction would lose, kept from the transcript by rule: the person's
 * requests, the files touched, the commands run and the last answer. No model
 * is asked, so writing it costs no tokens.
 */
export const buildHandoff = (messages: readonly SessionMessage[], when: string): string => {
  const calls = messages.flatMap(m => m.toolUses)
  const requests = messages.filter(m => m.role === 'user' && m.text.trim() !== '' && !NOT_A_REQUEST.test(m.text.trim())).slice(-8)
  const touched = calls.filter(c => EDIT_TOOLS.includes(c.tool) || c.tool === 'Read').flatMap(c => pathOf(c.input) ?? [])
  const scratch = unique(touched.filter(isTemp)).slice(-SCRATCH_MAX)
  const edited = unique(calls.filter(c => EDIT_TOOLS.includes(c.tool)).flatMap(c => pathOf(c.input) ?? [])).filter(p => !isTemp(p))
  const read = unique(calls.filter(c => c.tool === 'Read').flatMap(c => pathOf(c.input) ?? [])).filter(p => !edited.includes(p) && !isTemp(p))
  const commands = calls
    .filter(c => c.tool === 'Bash' && typeof c.input.command === 'string')
    .map(c => clip(String(c.input.command).split('\n')[0] ?? '', 140))
    .slice(-20)
  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')

  const lines = [
    '# Work notes saved before compaction',
    `Saved ${when}. The summary may have dropped detail; this has the raw facts.`,
    '',
    ...section('Recent requests (oldest first)', requests.map(m => `- ${clip(m.text, 400).replace(/\n+/g, ' ')}`)),
    ...section('Files edited or written', edited.slice(-40).map(p => `- ${p}`)),
    ...section('Files read', read.slice(-40).map(p => `- ${p}`)),
    ...section(`Scratch files in temp folders, written or read (latest ${SCRATCH_MAX})`, scratch.map(p => `- ${p}`)),
    ...section('Commands run (latest 20)', commands.map(c => `- ${c}`)),
    ...section('Last answer', lastAnswer === undefined ? [] : [clip(lastAnswer.text, 1500)]),
  ]
  return clip(lines.join('\n'), MAX_CHARS)
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
