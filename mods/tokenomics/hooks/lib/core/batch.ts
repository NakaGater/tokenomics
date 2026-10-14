import { fnv1a } from './hash'

/**
 * B7: one sentence added to the system prompt, asking the model to put reads that do not depend on each other into the same
 * response. Every response sends the whole conversation again, so a read that waited for its own response to be asked for is a
 * re-read that need not have happened. It changes what the model is told and nothing it is given: no tool, no refusal.
 *
 * Whether it works is for the ledger to say, so half of the sessions are left without it (`batchGroupOf`) and the two halves'
 * requests, calls and reads that came one at a time are set side by side (scripts/ledger-report.sh). Pure.
 */
export const BATCH_TEXT =
  "When you need several files or several read-only searches and none depends on another's result, ask for all of them in the same response instead of one per response; every response re-sends the whole conversation. Only ask for what you already know you need. If a read depends on what the previous one showed, read in order."

/** The section the engine adds last, after the cache boundary: it reads the same for the whole session. */
export const BATCH_SECTION = { id: 'tokenomics:batch-reads', text: BATCH_TEXT, scope: 'session' } as const

/** `on`: the sentence is given. `off`: the other half, left without it to be compared with. */
export type BatchGroup = 'on' | 'off'

/** Which half a session falls in: from the session alone, so every render of its prompt agrees and a reload does not move it. */
export const batchGroupOf = (sid: string): BatchGroup => (fnv1a(`batch:${sid}`) % 2 === 0 ? 'on' : 'off')
