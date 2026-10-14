import { type Engine, describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/lib/core/ledger'
import { type StepShape, readPathOf, requestShape } from '../hooks/lib/core/shape'

import { type Calls, engine, runStep } from './kit'

const step = (over: Partial<StepShape> = {}): StepShape => ({ prompt: 10_000, asked: 0, readOnly: 0, refused: 0, readPath: null, ...over })
/** A request that asked for `n` reads, all of which came back read-only. */
const reads = (n: number, over: Partial<StepShape> = {}): StepShape => step({ asked: n, readOnly: n, ...over })

describe('which file a request read', () => {
  test('the file of a lone Read', () => {
    expect(readPathOf([{ name: 'Read', input: { file_path: '/repo/a.ts' } }])).toBe('/repo/a.ts')
  })

  test('nothing for several calls, another tool, or a Read without a file', () => {
    expect(readPathOf([])).toBeNull()
    expect(readPathOf([{ name: 'Read', input: { file_path: '/a' } }, { name: 'Read', input: { file_path: '/b' } }])).toBeNull()
    expect(readPathOf([{ name: 'Grep', input: { file_path: '/a' } }])).toBeNull()
    expect(readPathOf([{ name: 'Read', input: {} }])).toBeNull()
    expect(readPathOf([{ name: 'Read', input: { file_path: '' } }])).toBeNull()
    expect(readPathOf([{ name: 'Read', input: { file_path: 3 } }])).toBeNull()
    expect(readPathOf([{ name: 'Read', input: null }])).toBeNull()
    expect(readPathOf([{ name: 'Read' }])).toBeNull()
  })
})

describe('the shape of a turn’s requests', () => {
  test('a turn with no request has none', () => {
    expect(requestShape([])).toBeNull()
  })

  test('a request that was opened and never answered is no request', () => {
    expect(requestShape([step({ prompt: 0, asked: 0 })])).toBeNull()
    const n = requestShape([reads(1, { prompt: 10_000 }), step({ prompt: 0 })])!
    expect(n.shpReqs).toBe(1)
    expect(n.shpPromptTok).toBe(10_000)
  })

  test('requests, their prompts and the ones that asked for a tool', () => {
    const n = requestShape([step({ prompt: 1_000, asked: 1 }), step({ prompt: 2_000, asked: 2 }), step({ prompt: 3_000 })])!
    expect(n.shpReqs).toBe(3)
    expect(n.shpPromptTok).toBe(6_000)
    expect(n.shpTools).toBe(2)
    // Calls, not requests: the two that came together are two.
    expect(n.shpCalls).toBe(3)
  })

  test('reads asked for together are the model batching already, and are no pair', () => {
    const n = requestShape([reads(3), reads(2), step()])!
    expect(n.shpParallel).toBe(2)
    expect(n.shpSerial).toBe(0)
    expect(n.shpSerialTok).toBe(0)
  })

  test('a lone read followed by another read request is a pair, with the prompt of the one that followed', () => {
    const n = requestShape([reads(1, { prompt: 10_000 }), reads(1, { prompt: 12_000 }), reads(1, { prompt: 14_000 }), step({ prompt: 16_000 })])!
    // 1→2 and 2→3; the last read is followed by the answer, which is no read.
    expect(n.shpSerial).toBe(2)
    expect(n.shpSerialTok).toBe(12_000 + 14_000)
    expect(n.shpParallel).toBe(0)
  })

  test('a lone read followed by a batch is a pair too: the batch could have taken it in', () => {
    const n = requestShape([reads(1, { prompt: 10_000 }), reads(3, { prompt: 12_000 })])!
    expect(n.shpSerial).toBe(1)
    expect(n.shpSerialTok).toBe(12_000)
    expect(n.shpParallel).toBe(1)
  })

  test('a request that wrote, ran something or answered breaks the chain', () => {
    const edit = step({ asked: 1, readOnly: 0, prompt: 11_000 })
    expect(requestShape([reads(1), edit, reads(1)])!.shpSerial).toBe(0)
    expect(requestShape([reads(1), step(), reads(1)])!.shpSerial).toBe(0)
    // A request after a write is a read after a write, not after a read.
    expect(requestShape([edit, reads(1)])!.shpSerial).toBe(0)
  })

  test('a request with a call that was not seen to come back read-only is not a read request', () => {
    // Asked for two, one answered (the turn was cut off, or a call was refused): not counted, whichever way.
    const cut = step({ asked: 2, readOnly: 1 })
    const n = requestShape([cut, reads(1)])!
    expect(n.shpParallel).toBe(0)
    expect(n.shpSerial).toBe(0)
    expect(requestShape([reads(1), cut])!.shpSerial).toBe(0)
  })

  test('the same file read twice in a row is told of apart from the pairs', () => {
    const n = requestShape([
      reads(1, { readPath: '/repo/a.ts' }),
      reads(1, { readPath: '/repo/a.ts' }),
      reads(1, { readPath: '/repo/b.ts' }),
      reads(1, { readPath: null }),
      reads(1, { readPath: null }),
    ])!
    expect(n.shpSerial).toBe(4)
    expect(n.shpSameFile).toBe(1)
  })

  test('a request the steering turned back is told, with the prompt of the request that came next', () => {
    const n = requestShape([
      reads(1, { prompt: 10_000 }),
      step({ asked: 1, refused: 1, prompt: 11_000 }),
      reads(1, { prompt: 12_000 }),
      step({ prompt: 13_000 }),
    ])!
    expect(n.shpRefused).toBe(1)
    expect(n.shpRefusedTok).toBe(12_000)
    // The refused request is not a read one, so it opens no pair and closes none; the later read is followed by the answer.
    expect(n.shpSerial).toBe(0)
  })

  test('a refusal in the last request has no request after it to cost', () => {
    const n = requestShape([step({ asked: 1, refused: 1 })])!
    expect(n.shpRefused).toBe(1)
    expect(n.shpRefusedTok).toBe(0)
  })

  test('every name fits what the ledger allows, and every figure is a count or a sum', () => {
    const n = requestShape([reads(1), reads(1, { readPath: 'x' }), step({ asked: 1, refused: 1 }), step()])!
    for (const [name, v] of Object.entries(n)) {
      expect(name).toMatch(/^[A-Za-z0-9_]{1,24}$/)
      expect(Number.isInteger(v) && v >= 0).toBe(true)
    }
  })
})

// ── In the engine ──

type Driver = Engine
type Options = NonNullable<Parameters<typeof engine>[1]>

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const USAGE = { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, model: 'claude-sonnet-5-5' }
const MAIN = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'claude-sonnet-5-5' }

const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit', sessionId: 's' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}
const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)
const sum = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.sums[key] ?? 0), 0)

const START_TURN = ($: Driver) => $.turn.start({ text: 'go', turnId: 't1' } as never)
const END_TURN = ($: Driver, over: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: MAIN, ...over } as never)

/** What the engine answers a tool call with: a read says it only reads, a write does not. */
const answers = (_$: unknown, e: { tool: unknown }) =>
  ({ result: { type: 'text' }, text: 'ok', ...(e.tool === 'Edit' ? {} : { isReadOnly: true }), ref: 1 }) as never

type Use = { name: string; input: unknown }
const read = (path: string): Use => ({ name: 'Read', input: { file_path: path } })
const edit = (path: string): Use => ({ name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } })

/**
 * One model request that asked for `uses`, and each of them run. The engine starts a call while the response is still coming in, so
 * the first `early` calls run before the request is answered (all of them by default, as when the tools are quick) and the rest after.
 */
let callNo = 0
const request = async ($: Driver, options: Options, uses: readonly Use[], cacheRead: number, early = uses.length, agentId?: string): Promise<void> => {
  const run = async (list: readonly Use[]) => {
    for (const use of list) {
      callNo += 1
      const input = use.input as Record<string, unknown>
      await $.tool.call({ tool: use.name, tool_use_id: `u${callNo}`, ...input, ...(agentId === undefined ? {} : { agentId }) } as never)
    }
  }
  options.stepToolUses = uses
  options.stepUsage = { ...USAGE, cache_read_input_tokens: cacheRead }
  options.duringStep = () => run(uses.slice(0, early))
  await runStep($ as never, agentId === undefined ? {} : { agentId })
  options.duringStep = undefined
  await run(uses.slice(early))
}

test('a turn is recorded by the shape of its requests, in counts and sums, and nothing of what was read', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: 's' }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await START_TURN($)

  await request($, options, [read('/repo/secret-name.ts'), read('/repo/b.ts')], 10_000) // batched: the model already does it
  await request($, options, [read('/repo/secret-name.ts')], 12_000) // a lone read…
  await request($, options, [read('/repo/secret-name.ts')], 14_000) // …and the same file again: a pair
  await request($, options, [edit('/repo/secret-name.ts')], 16_000) // a write: the chain ends
  await request($, options, [], 18_000) // the answer
  await END_TURN($)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:request_shape')).toBe(1)
  expect(sum(ledger, 'S:shpReqs')).toBe(5)
  expect(sum(ledger, 'S:shpTools')).toBe(4)
  expect(sum(ledger, 'S:shpCalls')).toBe(5)
  expect(sum(ledger, 'S:shpParallel')).toBe(1)
  // Only the second request is a lone read followed by another read request; the first is a batch, and the third is followed by a write.
  expect(sum(ledger, 'S:shpSerial')).toBe(1)
  expect(sum(ledger, 'S:shpSerialTok')).toBe(14_002)
  expect(sum(ledger, 'S:shpSameFile')).toBe(1)
  expect(sum(ledger, 'S:shpRefused')).toBe(0)
  const text = JSON.stringify(ledger)
  for (const left of ['secret-name', '/repo', 'Read', 'Edit', 'file_path']) expect(text).not.toContain(left)
})

test('a turn that asked for nothing, or whose requests the engine does not report, leaves no record', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: 's' })
  await $.session.start(START)
  await START_TURN($)
  await END_TURN($)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:request_shape')).toBe(0)
  expect(count(ledger, 'S:signal:observe:turn')).toBe(1)
})

test('what a subagent asked for and ran is not the conversation’s requests', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: 's' }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await START_TURN($)

  // A write, then a subagent's reads, then a main read: were the subagent's reads taken for the write's, the write would pass for a read.
  await request($, options, [edit('/repo/a.ts')], 10_000)
  await request($, options, [read('/repo/b.ts')], 3_000, undefined, 'sub-1')
  await request($, options, [read('/repo/c.ts')], 4_000, undefined, 'sub-1')
  await request($, options, [read('/repo/d.ts')], 12_000)
  await request($, options, [], 14_000)
  await END_TURN($)
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'S:shpReqs')).toBe(3)
  expect(sum(ledger, 'S:shpTools')).toBe(2)
  expect(sum(ledger, 'S:shpSerial')).toBe(0)
})

test('a turn that was cut off is counted as far as it went, and a call that never came back is not taken for a read', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: 's' }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await START_TURN($)

  await request($, options, [read('/repo/a.ts')], 10_000)
  await request($, options, [read('/repo/b.ts')], 12_000)
  // Asked for two reads, stopped after one.
  options.stepToolUses = [read('/repo/c.ts'), read('/repo/d.ts')]
  options.stepUsage = { ...USAGE, cache_read_input_tokens: 14_000 }
  options.duringStep = async () => {
    await $.tool.call({ tool: 'Read', tool_use_id: 'cut', file_path: '/repo/c.ts' } as never)
  }
  await runStep($ as never)
  // An interrupted turn carries no usage (nothing was counted in whole), whatever requests it made.
  await END_TURN($, { isAborted: true, reason: 'aborted', usage: undefined })
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'S:shpReqs')).toBe(3)
  expect(sum(ledger, 'S:shpParallel')).toBe(0)
  // a→b is a pair; b→(the cut one) is not, because that one never came back whole.
  expect(sum(ledger, 'S:shpSerial')).toBe(1)
})

test('the requests of one turn do not carry into the next', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: 's' }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await START_TURN($)
  await request($, options, [read('/repo/a.ts')], 10_000)
  await request($, options, [read('/repo/b.ts')], 12_000)
  await END_TURN($)

  await START_TURN($)
  await request($, options, [read('/repo/a.ts')], 14_000)
  await END_TURN($)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'S:signal:observe:request_shape')).toBe(2)
  expect(sum(ledger, 'S:shpReqs')).toBe(3)
  expect(sum(ledger, 'S:shpSerial')).toBe(1)
})

// The engine starts a call while the response is still coming in, so how much of a request's calls came before it was answered
// varies with how quick the tools are: the shape is the same either way.
for (const early of [0, 1, 3]) {
  test(`a batch of three reads is a batch whether ${early} of its calls ran before the request was answered or not`, async ($, on) => {
    const options: Options = { tmp: '/t', sessionId: 's' }
    const calls = engine(on, options)
    on('tool.call', answers)
    await $.session.start(START)
    await START_TURN($)

    await request($, options, [read('/repo/a.ts'), read('/repo/b.ts'), read('/repo/c.ts')], 10_000, early)
    await request($, options, [read('/repo/d.ts')], 12_000, early)
    await request($, options, [read('/repo/e.ts')], 14_000, early)
    await request($, options, [], 16_000)
    await END_TURN($)
    const ledger = await ledgerOf($, calls)

    expect(sum(ledger, 'S:shpReqs')).toBe(4)
    expect(sum(ledger, 'S:shpParallel')).toBe(1)
    // The lone read d is followed by the read e: one pair.
    expect(sum(ledger, 'S:shpSerial')).toBe(1)
    expect(sum(ledger, 'S:shpSerialTok')).toBe(14_002)
  })
}

// ── The steering turns a call back ──

const AUTO = { options: { digest: 'off', steer: 'auto' } } as const
const BIG = 'x'.repeat(3000)
/** A search result of 3,000 characters: enough, from two searches, for a hand-over to pay (see steer.test.ts). */
const searches = (_$: unknown, _e: unknown) => ({ result: { stdout: BIG, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: BIG, isReadOnly: true, ref: 1 }) as never

for (const early of [0, 1]) {
  test(`a search the steering turned back is told, with the request that came after it, and opens no pair (${early ? 'before' : 'after'} its request was answered)`, AUTO, async ($, on) => {
    const options: Options = { tmp: '/t', sessionId: 's' }
    const calls = engine(on, options)
    on('tool.call', searches)
    await $.session.start(START)
    await START_TURN($)

    const grep = (n: number): Use => ({ name: 'Bash', input: { command: `grep -rn needle${n} src` } })
    await request($, options, [grep(1)], 10_000, early)
    await request($, options, [grep(2)], 12_000, early) // turned back with a note: no result, one more request to be told
    await request($, options, [read('/repo/a.ts')], 14_000, early)
    await request($, options, [], 16_000)
    await END_TURN($)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, 'B6:fired:auto:search')).toBe(1)
    expect(sum(ledger, 'S:shpRefused')).toBe(1)
    expect(sum(ledger, 'S:shpRefusedTok')).toBe(14_002)
    // The first search read, the second was refused: the refused one is not a read that could have shared the one before it.
    expect(sum(ledger, 'S:shpSerial')).toBe(0)
  })
}

test('the same search made again runs, and is a read like any other', AUTO, async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: 's' }
  const calls = engine(on, options)
  on('tool.call', searches)
  await $.session.start(START)
  await START_TURN($)

  const grep: Use = { name: 'Bash', input: { command: 'grep -rn needle src' } }
  await request($, options, [grep], 10_000)
  await request($, options, [{ name: 'Bash', input: { command: 'grep -rn other src' } }], 12_000) // turned back
  await request($, options, [{ name: 'Bash', input: { command: 'grep -rn other src' } }], 14_000) // insisted on: runs
  await request($, options, [], 16_000)
  await END_TURN($)
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'S:shpRefused')).toBe(1)
  expect(sum(ledger, 'S:shpRefusedTok')).toBe(14_002)
  expect(sum(ledger, 'S:shpSerial')).toBe(0)
})
