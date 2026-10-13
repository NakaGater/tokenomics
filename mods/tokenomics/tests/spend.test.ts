import type { SessionMessage } from 'claude-code'
import { type Engine, describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/lib/core/ledger'
import { advisorMs, advisorRead, noteOpenedBy, noteWritten, subagentSpend, MAX_NOTES, type KnownNote } from '../hooks/lib/core/spend'

import { type Calls, engine, runStep } from './kit'

describe('what a subagent run spent, by kind of token', () => {
  const usage = { input_tokens: 120, output_tokens: 700, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 3_000 }

  test('is kept under the model’s family, each kind of token apart, cache reads included', () => {
    expect(subagentSpend({ ...usage, model: 'claude-haiku-5-5' })).toEqual({
      tag: 'sub_haiku',
      n: { subIn_haiku: 120, subWrite_haiku: 3_000, subRead_haiku: 40_000, subOut_haiku: 700 },
    })
    expect(subagentSpend({ ...usage, model: 'claude-opus-5-5' }).tag).toBe('sub_opus')
    expect(subagentSpend({ ...usage, model: 'sonnet[1m]' }).tag).toBe('sub_sonnet')
    expect(subagentSpend({ ...usage, model: 'something-else' }).tag).toBe('sub_other')
  })

  test('every name fits what the ledger allows', () => {
    for (const model of ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'x']) {
      const { tag, n } = subagentSpend({ ...usage, model })
      expect(tag).toMatch(/^[A-Za-z0-9_.:-]{1,40}$/)
      for (const name of Object.keys(n)) expect(name).toMatch(/^[A-Za-z0-9_]{1,24}$/)
    }
  })
})

describe('what the advisor read, as far as it can be told', () => {
  const step = { input_tokens: 4, output_tokens: 700, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 4_000 }

  test('is the step’s prompt over the main requests it holds: one before the advisor and one after each call', () => {
    expect(advisorRead(step, 1)).toBe(102_002)
    expect(advisorRead(step, 2)).toBe(68_001)
  })

  test('is not told without figures or calls', () => {
    expect(advisorRead(null, 1)).toBeNull()
    expect(advisorRead(undefined, 1)).toBeNull()
    expect(advisorRead(step, 0)).toBeNull()
  })

  test('how long a call took is told only when it ended, and not when the clock is not to be believed', () => {
    expect(advisorMs({ startedAt: 1_000, endedAt: 4_200 })).toBe(3_200)
    expect(advisorMs({ startedAt: 1_000 })).toBeNull()
    expect(advisorMs({ startedAt: 5_000, endedAt: 1_000 })).toBeNull()
    expect(advisorMs({ startedAt: 0, endedAt: 7_200_000 })).toBeNull()
  })
})

describe('which tool call opens a note', () => {
  const D = '/var/folders/x/T/claude-tokenomics/sess'

  test('a Read of it, by its file name, with whether the folder is the plugin’s own', () => {
    expect(noteOpenedBy('Read', { file_path: `${D}/handoff-3.md` })).toEqual({ name: 'handoff-3.md', isInTemp: true })
    expect(noteOpenedBy('Read', { file_path: '/repo/docs/handoff-3.md' })).toEqual({ name: 'handoff-3.md', isInTemp: false })
    expect(noteOpenedBy('Read', { file_path: `${D}/handoff-1791729794403.md` })?.name).toBe('handoff-1791729794403.md')
  })

  test('a command that shows it, though the folder is in a variable set a line before', () => {
    const command = `D=${D}; ls -la "$D"; echo ---; head -c 1200 "$D/handoff-2.md"; echo`
    expect(noteOpenedBy('Bash', { command })).toEqual({ name: 'handoff-2.md', isInTemp: true })
    expect(noteOpenedBy('Bash', { command: 'cat "$D/handoff-4.md"' })).toEqual({ name: 'handoff-4.md', isInTemp: false })
    expect(noteOpenedBy('Bash', { command: 'tail -n 20 /x/handoff-4.md | less' })?.name).toBe('handoff-4.md')
    expect(noteOpenedBy('Bash', { command: 'sed -n 1,40p $D/handoff-5.md' })?.name).toBe('handoff-5.md')
  })

  test('writing about a note, or to it, opens nothing', () => {
    expect(noteOpenedBy('Bash', { command: `ls -la ${D}/handoff-2.md` })).toBeNull()
    expect(noteOpenedBy('Bash', { command: `cat >> memory/redesign.md <<'EOF'\n- the note handoff-1.md was read\nEOF` })).toBeNull()
    expect(noteOpenedBy('Bash', { command: `cat ${D}/a.log > ${D}/handoff-1.md` })).toBeNull()
    expect(noteOpenedBy('Bash', { command: `sed -i 's/a/b/' ${D}/handoff-1.md` })).toBeNull()
    expect(noteOpenedBy('Bash', { command: 'git commit -m "handoff-1.md"' })).toBeNull()
    expect(noteOpenedBy('Edit', { file_path: `${D}/handoff-1.md` })).toBeNull()
    expect(noteOpenedBy('Read', { file_path: `${D}/handoff.ts` })).toBeNull()
    expect(noteOpenedBy('Read', { file_path: `${D}/not-handoff-1.md` })).toBeNull()
  })

  test('the notes remembered are held to a number: the oldest goes', () => {
    let notes = new Map<string, KnownNote>()
    for (let i = 0; i < MAX_NOTES + 3; i += 1) notes = noteWritten(notes, `handoff-${i}.md`, { kind: 'compaction', turn: i, isOpened: false })
    expect(notes.size).toBe(MAX_NOTES)
    expect(notes.has('handoff-0.md')).toBe(false)
    expect(notes.has(`handoff-${MAX_NOTES + 2}.md`)).toBe(true)
  })
})

// ── In the engine ──

type Driver = Engine

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const DIR = '/t/claude-tokenomics/s'
const transcript: SessionMessage[] = [
  { role: 'user', text: 'Add a dark mode toggle', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/theme.ts' } }] },
  { role: 'assistant', text: 'Done.', toolUses: [] },
]
const MAIN = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'claude-sonnet-5-5' }

const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit', sessionId: 's' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}
const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)
const sum = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.sums[key] ?? 0), 0)

const mainEnds = ($: Driver, id: string) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage: MAIN } as never)
const subEnds = ($: Driver, agentId: string, usage: typeof MAIN) =>
  $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: `${agentId}-t`, reason: 'answer', agentId, usage } as never)
/** What the engine answers a tool call with; a call named `denied` is refused, one named `failed` errors. */
const answers = (_$: unknown, e: { tool_use_id: string }) =>
  e.tool_use_id === 'denied'
    ? ({ deny: 'no' } as never)
    : ({ result: { type: 'text' }, text: 'ok', isReadOnly: true, ref: 1, ...(e.tool_use_id === 'failed' ? { isError: true } : {}) } as never)
const compactInput = () => ({ trigger: 'manual', messages: transcript }) as never
const sessionStart = ($: Driver, source: string) => $.classic.SessionStart({ source } as never)

test('every subagent run is counted by the kind of token and the family of its model, with delegation off, and the main turn is not', { options: { delegation: 'off' } }, async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's' })
  await $.session.start(START)

  await subEnds($, 'ag1', { ...MAIN, model: 'claude-haiku-5-5', input_tokens: 200, output_tokens: 900, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 })
  await subEnds($, 'ag2', { ...MAIN, model: 'claude-haiku-5-5', input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 })
  await subEnds($, 'ag3', { ...MAIN, model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 4_000 })
  await mainEnds($, 't1')
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:sub_haiku')).toBe(2)
  expect(count(ledger, 'S:signal:observe:sub_opus')).toBe(1)
  expect(count(ledger, 'S:signal:observe:sub_sonnet')).toBe(0)
  expect(sum(ledger, 'S:subIn_haiku')).toBe(250)
  expect(sum(ledger, 'S:subWrite_haiku')).toBe(2_000)
  expect(sum(ledger, 'S:subRead_haiku')).toBe(40_000)
  expect(sum(ledger, 'S:subOut_haiku')).toBe(1_000)
  expect(sum(ledger, 'S:subRead_opus')).toBe(60_000)
  // The main turn is its own record and stays what it was.
  expect(count(ledger, 'S:signal:observe:turn')).toBe(1)
})

test('each call of the advisor is counted, with what it read (an estimate) and how long it took', async ($, on) => {
  const stepUsage = { input_tokens: 4, output_tokens: 700, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 4_000, model: 'claude-sonnet-5-5' }
  const serverToolUses: { id: string; name: string; input: unknown; startedAt: number; endedAt?: number }[] = [
    { id: 's1', name: 'advisor', input: {}, startedAt: 1_000, endedAt: 4_000 },
  ]
  const options = { tmp: '/t', sessionId: 's', stepUsage, serverToolUses }
  const calls = engine(on, options)
  await $.session.start(START)

  await runStep($ as never)
  // Two calls in one step: the prompt is shared among three requests; a step without the advisor adds nothing; a subagent's is apart.
  options.serverToolUses = [
    { id: 's2', name: 'advisor', input: {}, startedAt: 10_000, endedAt: 12_000 },
    { id: 's3', name: 'advisor', input: {}, startedAt: 12_000 },
    { id: 's4', name: 'web_search', input: {}, startedAt: 12_000, endedAt: 12_500 },
  ]
  await runStep($ as never)
  options.serverToolUses = []
  await runStep($ as never)
  options.serverToolUses = [{ id: 's5', name: 'advisor', input: {}, startedAt: 20_000, endedAt: 21_000 }]
  await runStep($ as never, { agentId: 'sub-1' })
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:advisor')).toBe(3)
  expect(count(ledger, 'S:signal:observe:advisor_sub')).toBe(1)
  // 204,004 over 2 requests; over 3 (two calls) twice: 102,002 + 68,001 × 2 for the main conversation, 102,002 for the subagent's.
  expect(sum(ledger, 'S:advIn')).toBe(102_002 + 68_001 * 2 + 102_002)
  expect(sum(ledger, 'S:advMs')).toBe(3_000 + 2_000 + 1_000)
})

test('the first opening of a note written before a compaction is counted by its kind and how many turns after; a second is not', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  on('tool.call', answers)
  await $.session.start(START)
  await $.session.compact(compactInput())
  await sessionStart($, 'compact')
  await mainEnds($, 't1')
  await mainEnds($, 't2')

  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: `D=${DIR}; ls "$D"; head -c 1200 "$D/handoff-1.md"` } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${DIR}/handoff-1.md` } as never)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:compact_pointer_given')).toBe(1)
  expect(count(ledger, 'S:signal:observe:note_read_compaction')).toBe(1)
  expect(sum(ledger, 'S:noteTurns')).toBe(2)
  // Nothing of where it is, or what it was called, reaches the ledger.
  expect(JSON.stringify(ledger)).not.toContain('handoff')
  expect(JSON.stringify(ledger)).not.toContain('claude-tokenomics')
})

test('a subagent’s reading, a denied or failed one, another file of that name and a note’s mention are not openings', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  on('tool.call', answers)
  await $.session.start(START)
  await $.session.compact(compactInput())
  await sessionStart($, 'compact')

  await $.tool.call({ tool: 'Read', tool_use_id: 'sub', file_path: `${DIR}/handoff-1.md`, agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'denied', file_path: `${DIR}/handoff-1.md` } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'failed', file_path: `${DIR}/handoff-1.md` } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'other', file_path: '/repo/docs/handoff-7.md' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'm', command: `cat >> memory.md <<'EOF'\n- read handoff-1.md\nEOF` } as never)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:note_read_compaction')).toBe(0)
  expect(count(ledger, 'S:signal:observe:note_read_other')).toBe(0)
})

test('a note this module did not write counts as opened when it is in the plugin’s own folder', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's' })
  on('tool.call', answers)
  await $.session.start(START)

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${DIR}/handoff-9.md` } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: `${DIR}/handoff-9.md` } as never)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:note_read_other')).toBe(1)
  expect(sum(ledger, 'S:noteTurns')).toBe(0)
})

test('the note a /clear leaves and the one /tokenomics handoff writes are counted when they are opened', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's', messages: transcript })
  on('tool.call', answers)
  await $.session.start(START)

  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  const cleared = calls.writes.find(w => /handoff-\d+\.md$/.test(w.path))!.path
  await sessionStart($, 'clear')
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: cleared } as never)

  // A note is named by the time it was written: the clock moves on, as it does.
  await calls.clock.advance(5_000)
  await $.command.run({ command: 'tokenomics', args: 'handoff', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  const fresh = calls.writes.filter(w => /handoff-\d+\.md$/.test(w.path)).map(w => w.path).find(path => path !== cleared)!
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: `cat ${fresh}` } as never)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:clear_note_written')).toBe(1)
  expect(count(ledger, 'S:signal:observe:fresh_note_written')).toBe(1)
  expect(count(ledger, 'S:signal:observe:note_read_clear')).toBe(1)
  expect(count(ledger, 'S:signal:observe:note_read_fresh')).toBe(1)
})
