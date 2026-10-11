/** What a digested command output keeps. */
export const DIGEST = {
  /** Output under this many characters is left alone. */
  overChars: 9_000,
  head: 30,
  tail: 40,
  /** Lines kept around each line that looks like a failure. */
  around: 2,
  /** Most lines kept for failures in all. */
  matched: 60,
  /** Most lines kept for the lines that sum a run up. */
  summary: 20,
  /** For output that is a few very long lines: how much of each end to keep. */
  headChars: 4_000,
  tailChars: 2_000,
} as const

const FAILURE = /error|fail|exception|panic|traceback|fatal|assert|denied|✗|✘/i
// The lines a test or build tool ends with (vitest, jest, pytest, maven, gradle, cargo, swift, xcodebuild): kept wherever they stand.
const SUMMARY =
  /Tests?:|Test Files|Test Suites:|Tests run:|BUILD (?:SUCCESS|FAIL|SUCCESSFUL)|\b\d+ (?:passed|failed)\b|Executed \d+ tests?|test result:|Ran \d+ tests?|\*\* TEST (?:SUCCEEDED|FAILED)/i

export type Digest = {
  /** What the model reads in place of the output: a pointer to the full text, then what was kept. */
  text: string
  /** Characters the model no longer has to read. */
  savedChars: number
}

const pointer = (kept: string, path: string): string =>
  `[tokenomics shortened this output: ${kept}. The full text is saved in ${path}; read it with the Read tool (offset, limit) if you need more.]`

/** A few very long lines (minified or one-line JSON): keep the two ends. */
const cutChars = (text: string, path: string): string => {
  const kept = DIGEST.headChars + DIGEST.tailChars
  return [
    pointer(`kept ${kept} of ${text.length} characters (the start and the end)`, path),
    text.slice(0, DIGEST.headChars),
    `… (${text.length - kept} characters omitted) …`,
    text.slice(-DIGEST.tailChars),
  ].join('\n')
}

/**
 * A large command output cut down to its start, the lines that look like failures with a little around them, the
 * lines that sum a run up, and its end; null when it is small enough to leave alone. The exit status is not touched:
 * only the text the model reads. Nothing is lost: the full text is where `path` says.
 */
export const digestOutput = (text: string, path: string, overChars: number = DIGEST.overChars): Digest | null => {
  if (text.length <= overChars) return null
  const lines = text.split('\n')
  if (lines.length <= DIGEST.head + DIGEST.tail + 10) {
    const cut = cutChars(text, path)
    return worthKeeping(text, cut)
  }

  const bodyEnd = lines.length - DIGEST.tail
  const keep = new Set<number>()
  for (let i = 0; i < DIGEST.head; i += 1) keep.add(i)
  for (let i = bodyEnd; i < lines.length; i += 1) keep.add(i)

  let matched = 0
  let summed = 0
  for (let i = DIGEST.head; i < bodyEnd; i += 1) {
    const line = lines[i] ?? ''
    if (summed < DIGEST.summary && SUMMARY.test(line)) {
      keep.add(i)
      summed += 1
    }
    if (matched >= DIGEST.matched || !FAILURE.test(line)) continue
    for (let j = Math.max(DIGEST.head, i - DIGEST.around); j <= Math.min(bodyEnd - 1, i + DIGEST.around); j += 1) {
      if (!keep.has(j)) {
        keep.add(j)
        matched += 1
      }
    }
  }

  const out: string[] = [pointer(`kept ${keep.size} of ${lines.length} lines: the start, lines that look like failures, summary lines, the end`, path)]
  let skipped = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep.has(i)) {
      skipped += 1
      continue
    }
    if (skipped > 0) out.push(`… (${skipped} lines omitted) …`)
    skipped = 0
    out.push(lines[i] ?? '')
  }
  return worthKeeping(text, out.join('\n'))
}

/** A digest this much shorter than the output, at most; a longer one is not worth the pointer, and the output is left as it was. */
const MAX_SHARE = 0.8

const worthKeeping = (text: string, cut: string): Digest | null =>
  cut.length <= text.length * MAX_SHARE ? { text: cut, savedChars: text.length - cut.length } : null

/** Whether `path` is a file under `dir`, spelled plainly: no `.` or `..` part, no doubled slash tricks, nothing past the folder. */
export const isInsideDir = (dir: string, path: string): boolean => {
  if (path.includes('\0') || dir === '') return false
  const parts = path.split('/')
  if (parts.includes('..') || parts.includes('.')) return false
  const base = dir.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  const plain = path.replace(/\/{2,}/g, '/')
  return plain.startsWith(`${base}/`) && plain.length > base.length + 1
}

/** A tool call's id as a file name. */
const safeName = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)

/** Where the full text of one command's output is kept. */
export const digestPath = (dir: string, toolUseId: string): string => `${dir}/out-${safeName(toolUseId)}.log`

/** Whether `path` names a saved command output (not the work notes kept beside them). */
export const isDigestFile = (path: string): boolean => /\/out-[A-Za-z0-9_-]+\.log$/.test(path)

/** A command as it is compared with an earlier one: the same words, one space between. */
export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, ' ')
