/**
 * The shape of a turn's requests: how many there were, and how many of them only went to read something one at a time. A turn is
 * several requests (each tool call is answered by another), and every one sends the whole conversation again, so a request
 * that could have shared the one before it is a re-read of the conversation that did not need to happen.
 *
 * What is told here is an UPPER BOUND on that. The plugin sees that a read was asked for right after another read; it cannot see
 * whether the second one depended on the first (a file read to learn which file to read next cannot be asked for together
 * with it). Counts and numbers only: a path is compared in memory, to see that the same file was read twice in a row, and is never
 * kept. Pure.
 */

/** One request of the main conversation, with what became of the tool calls it asked for. */
export type StepShape = {
  /** The prompt the request sent (input + cache write + cache read). */
  prompt: number
  /** The tool calls the response asked the engine to run. */
  asked: number
  /** ...of which the tool reported as read-only by its own check (the engine's flag, not a guess). */
  readOnly: number
  /** ...of which the steering turned back (a note came in place of the result). */
  refused: number
  /** The file, when the one call was a Read of a file: for comparing with the next request's, never recorded. */
  readPath: string | null
}

/** The file a lone Read asked for, or null: any other call, or several at once. */
export const readPathOf = (uses: readonly { name: string; input?: unknown }[]): string | null => {
  const only = uses.length === 1 ? uses[0] : undefined
  if (only === undefined || only.name !== 'Read') return null
  const input = only.input
  if (typeof input !== 'object' || input === null) return null
  const path = (input as Record<string, unknown>).file_path

  return typeof path === 'string' && path.length > 0 ? path : null
}

/** A request whose calls all came back read-only (a request that asked for nothing is not one). */
const isReadStep = (s: StepShape): boolean => s.asked > 0 && s.readOnly >= s.asked

/**
 * What one turn's requests come to, as ledger numbers (names are short: the ledger allows 24 characters).
 *   shpReqs       requests in the turn
 *   shpPromptTok  the prompts they sent, summed (what the figures below are set against)
 *   shpTools      requests that asked for a tool
 *   shpCalls      tool calls asked for, in all (a request that asks for more than it needs shows here)
 *   shpParallel   requests that asked for two or more reads at once: the model batching, already
 *   shpSerial     a request with exactly one read, followed by a request that also only reads. UPPER BOUND on the requests that
 *                 could have been folded into the one before
 *   shpSerialTok  the prompts of those following requests: the re-reading that folding would have spared, at most
 *   shpSameFile   of shpSerial, the pairs that read the same file twice in a row (a file read in parts): the likelier ones
 *   shpRefused    requests with a call the steering turned back
 *   shpRefusedTok the prompts of the requests that came next: what it cost to be told, which is itself a request
 * Null for a turn with no request answered.
 */
export const requestShape = (all: readonly StepShape[]): Record<string, number> | null => {
  // A request that was opened and never answered (the turn was cut off in it) sent nothing that was counted: it is no request.
  const steps = all.filter(s => s.prompt > 0)
  if (steps.length === 0) return null
  let tools = 0
  let calls = 0
  let parallel = 0
  let serial = 0
  let serialTok = 0
  let sameFile = 0
  let refused = 0
  let refusedTok = 0
  steps.forEach((s, i) => {
    if (s.asked > 0) tools += 1
    calls += s.asked
    if (isReadStep(s) && s.asked >= 2) parallel += 1
    if (s.refused > 0) refused += 1
    const next = steps[i + 1]
    if (next === undefined) return
    if (s.refused > 0) refusedTok += next.prompt
    if (isReadStep(s) && s.asked === 1 && isReadStep(next)) {
      serial += 1
      serialTok += next.prompt
      if (s.readPath !== null && s.readPath === next.readPath) sameFile += 1
    }
  })

  return {
    shpReqs: steps.length,
    shpPromptTok: steps.reduce((sum, s) => sum + s.prompt, 0),
    shpTools: tools,
    shpCalls: calls,
    shpParallel: parallel,
    shpSerial: serial,
    shpSerialTok: serialTok,
    shpSameFile: sameFile,
    shpRefused: refused,
    shpRefusedTok: refusedTok,
  }
}
