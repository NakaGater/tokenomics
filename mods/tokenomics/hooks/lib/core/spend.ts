import { modelFamily } from './economics'

/**
 * What the plugin can see of tokens that are not the main conversation's: a subagent's run, an advisor's call, and the notes it
 * wrote for the conversation to read again. Counts and numbers only; no path, no command, no word of the person's. Pure.
 */

type Counts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * What a subagent's run spent, by kind of token. A ledger sum is kept by name alone (the tag is not part of it), so the model's
 * family is in each name: Haiku's reads and Opus's are not the same price, and a sum of both would say nothing.
 * The run is counted under `sub_<family>`; the tokens are the API's own, cache reads kept apart from the rest.
 */
export const subagentSpend = (usage: Counts & { model: string }): { tag: string; n: Record<string, number> } => {
  const family = modelFamily(usage.model) ?? 'other'

  return {
    tag: `sub_${family}`,
    n: {
      [`subIn_${family}`]: usage.input_tokens,
      [`subWrite_${family}`]: usage.cache_creation_input_tokens,
      [`subRead_${family}`]: usage.cache_read_input_tokens,
      [`subOut_${family}`]: usage.output_tokens,
    },
  }
}

/**
 * What the advisor read in one call, as far as it can be told. The API keeps the advisor's own tokens out of the figures a hook
 * is given; what it gives is the step's, which holds the main model's requests (one before the advisor, one after each call).
 * The advisor reads the conversation as the first of them sent it, so the step's prompt over those requests is the estimate
 * (on this PC, 33 calls: the advisor read 1.00 times the first request's prompt, 0.89 at the 10th percentile, 1.01 at the 90th).
 * Its output is not told at all.
 */
export const advisorRead = (step: Counts | null | undefined, calls: number): number | null => {
  if (step === null || step === undefined || calls < 1) return null
  const prompt = step.input_tokens + step.cache_read_input_tokens + step.cache_creation_input_tokens

  return Math.round(prompt / (calls + 1))
}

/** How long an advisor call took, in milliseconds; null when it did not end in the response or the clock is not to be believed. */
export const advisorMs = (use: { startedAt: number; endedAt?: number }): number | null => {
  if (use.endedAt === undefined) return null
  const ms = use.endedAt - use.startedAt

  return Number.isFinite(ms) && ms >= 0 && ms <= 3_600_000 ? Math.round(ms) : null
}

export type NoteKind = 'compaction' | 'clear' | 'fresh'

/** A note the mod wrote this session (`other`: one opened that this module did not write, as after a reload), and whether it was opened. */
export type KnownNote = { kind: NoteKind | 'other'; turn: number; isOpened: boolean }

/** The notes remembered at once; the oldest is forgotten past this. */
export const MAX_NOTES = 32

/** The file name of a note (`handoff-3.md`, `handoff-1791729794403.md`): all the plugin names a note by. */
const NOTE_FILE = /(?:^|[/"'\s=])(handoff-[A-Za-z0-9]{1,16}\.md)(?![\w.-])/

/** The commands that show a file's content as it is. */
const SHOWS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'bat'])

/** One command of a line, without its leading `VAR=value`s and without the file descriptors it redirects. */
const bare = (part: string): string[] =>
  part
    .replace(/\d*>&\d+/g, '')
    .replace(/\d*>>?\s*\/dev\/null/g, '')
    .trim()
    .replace(/^(?:\w+=\S*\s+)+/, '')
    .split(/\s+/)

/** Whether a command of a Bash line shows the content of a file (and writes nothing). */
const showsFile = (part: string): boolean => {
  if (part.includes('<<') || part.includes('>')) return false
  const words = bare(part)
  const word = words[0] ?? ''
  if (SHOWS.has(word)) return true

  return word === 'sed' && words.includes('-n') && !words.some(w => /^-[a-zA-Z]*i/.test(w))
}

/**
 * The note a tool call opens, by its file name, or null: a Read of it, or a Bash command that shows it (`cat`, `head`, `tail`,
 * `less`, `sed -n`). The full path is not asked for: a command often holds it in a variable set a line before. Writing about a
 * note (an edit of some other file that names it) opens nothing.
 */
export const noteOpenedBy = (tool: string, input: Record<string, unknown>): { name: string; isInTemp: boolean } | null => {
  if (tool === 'Read') {
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    const name = NOTE_FILE.exec(path)?.[1]

    return name === undefined ? null : { name, isInTemp: path.includes('/claude-tokenomics/') }
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return null
  const parts = input.command.split(/&&|\|\||;|\||\n/).filter(part => showsFile(part) && NOTE_FILE.test(part))
  const name = parts.map(part => NOTE_FILE.exec(part)?.[1]).find(found => found !== undefined)

  return name === undefined ? null : { name, isInTemp: input.command.includes('claude-tokenomics') }
}

/** The notes remembered with one more; past `MAX_NOTES` the oldest goes. */
export const noteWritten = (notes: ReadonlyMap<string, KnownNote>, name: string, note: KnownNote): Map<string, KnownNote> => {
  const next = new Map(notes)
  next.delete(name)
  next.set(name, note)
  while (next.size > MAX_NOTES) next.delete(next.keys().next().value as string)

  return next
}
