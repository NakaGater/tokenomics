import { type Engine, describe, expect, test } from 'claude-code/testing'

import { BATCH_SECTION, BATCH_TEXT, type BatchGroup, batchGroupOf } from '../hooks/lib/core/batch'
import { parseLedger, sessionKey } from '../hooks/lib/core/ledger'

import { type Calls, engine, runStep } from './kit'

describe('the sentence asking for reads that do not depend on each other to be put together', () => {
  test('is one short section at the end, on the session side of the cache boundary, under the plugin’s own id', () => {
    expect(BATCH_SECTION.scope).toBe('session')
    expect(BATCH_SECTION.id).toBe('tokenomics:batch-reads')
    expect(BATCH_SECTION.text).toBe(BATCH_TEXT)
    // About seventy tokens a request, read from the cache.
    expect(BATCH_TEXT.length).toBeLessThan(450)
  })

  test('limits itself to reads that need nothing from each other and to what is already known to be needed', () => {
    expect(BATCH_TEXT).toContain('none depends on another')
    expect(BATCH_TEXT).toContain('Only ask for what you already know you need')
    expect(BATCH_TEXT).toContain('read in order')
  })

  test('a session’s half comes from the session alone, and the halves are about equal', () => {
    expect(batchGroupOf('abc12345')).toBe(batchGroupOf('abc12345'))
    const ids = Array.from({ length: 2000 }, (_, i) => sessionKey(`session-${i}`))
    const on = ids.filter(id => batchGroupOf(id) === 'on').length
    expect(on).toBeGreaterThan(900)
    expect(on).toBeLessThan(1100)
  })
})

// ── In the engine ──

type Driver = Engine
type Options = NonNullable<Parameters<typeof engine>[1]>

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

/** A session id that falls in the half asked for. */
const sessionIn = (group: BatchGroup): string => {
  for (let i = 0; i < 1000; i += 1) {
    const id = `s${i}`
    if (batchGroupOf(sessionKey(id)) === group) return id
  }
  throw new Error('no session id found')
}

const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}
const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)
const sum = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.sums[key] ?? 0), 0)

const compose = ($: Driver, traits: readonly string[] = []) =>
  $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: ['Read', 'Bash'], outputStyle: null, traits } as never)
const ids = (sections: readonly { id: string }[]): string[] => sections.map(s => s.id)

test('in the half that is given the sentence, it is the last section of the prompt, and is written once however often the prompt is composed', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: sessionIn('on') })
  await $.session.start(START)

  const first = await compose($)
  expect(ids(first.sections)).toEqual(['intro', 'tokenomics:batch-reads'])
  expect(first.sections[1]).toEqual(BATCH_SECTION)
  const again = await compose($)
  expect(ids(again.sections)).toEqual(['intro', 'tokenomics:batch-reads'])
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B7:fired:auto:session_on')).toBe(1)
  expect(count(ledger, 'B7:signal:auto:session_off')).toBe(0)
  // Not a word of it in the ledger.
  expect(JSON.stringify(ledger)).not.toContain('depends')
})

test('in the other half the prompt is left as it was, and the session is written down as the one to compare with', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: sessionIn('off') })
  await $.session.start(START)

  expect(ids((await compose($)).sections)).toEqual(['intro'])
  expect(ids((await compose($)).sections)).toEqual(['intro'])
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B7:signal:auto:session_off')).toBe(1)
  expect(count(ledger, 'B7:fired:auto:session_on')).toBe(0)
})

test('set to observe, no session is given it, and the ledger says that it would have been', { options: { batch: 'observe' } }, async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: sessionIn('on') })
  await $.session.start(START)

  expect(ids((await compose($)).sections)).toEqual(['intro'])
  expect(ids((await compose($)).sections)).toEqual(['intro'])
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B7:would:observe:session')).toBe(1)
  expect(count(ledger, 'B7:fired:auto:session_on')).toBe(0)
})

test('off: nothing is added and nothing is written', { options: { batch: 'off' } }, async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: sessionIn('on') })
  await $.session.start(START)

  expect(ids((await compose($)).sections)).toEqual(['intro'])
  const ledger = await ledgerOf($, calls)

  expect(ledger.days.flatMap(d => Object.keys(d.counts)).filter(k => k.startsWith('B7:'))).toEqual([])
})

test('a person held back from the measures is given no sentence either, and it is only written that it would have been', { options: { holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: sessionIn('on') })
  await $.session.start(START)

  expect(ids((await compose($)).sections)).toEqual(['intro'])
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B7:would:observe:session')).toBe(1)
  expect(count(ledger, 'B7:fired:auto:session_on')).toBe(0)
})

test('the one-line prompt takes no section, and a session that runs on it is no part of the comparison', async ($, on) => {
  const calls = engine(on, { tmp: '/t', sessionId: sessionIn('on') })
  await $.session.start(START)

  expect(ids((await compose($, ['bare'])).sections)).toEqual(['intro'])
  const ledger = await ledgerOf($, calls)

  expect(ledger.days.flatMap(d => Object.keys(d.counts)).filter(k => k.startsWith('B7:'))).toEqual([])
})

// ── What the turns of each half came to ──

const answers = () => ({ result: { type: 'text' }, text: 'ok', isReadOnly: true, ref: 1 }) as never

/** One turn: a read, then the answer. */
const turn = async ($: Driver, options: Options): Promise<void> => {
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  options.stepToolUses = [{ name: 'Read', input: { file_path: '/repo/a.ts' } }]
  options.stepUsage = { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, model: 'claude-sonnet-5-5' }
  await runStep($ as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/repo/a.ts' } as never)
  options.stepToolUses = []
  options.stepUsage = { ...options.stepUsage, cache_read_input_tokens: 11_000 }
  await runStep($ as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: { input_tokens: 4, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 21_000, model: 'claude-sonnet-5-5' } } as never)
}

for (const group of ['on', 'off'] as const) {
  const other = group === 'on' ? 'off' : 'on'
  test(`a turn is counted under the half its session is in (${group}), and only there`, async ($, on) => {
    const options: Options = { tmp: '/t', sessionId: sessionIn(group) }
    const calls = engine(on, options)
    on('tool.call', answers)
    await $.session.start(START)
    await compose($)
    await turn($, options)
    await turn($, options)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, `B7:signal:auto:turns_${group}`)).toBe(2)
    expect(sum(ledger, `B7:reqs_${group}`)).toBe(4)
    expect(sum(ledger, `B7:calls_${group}`)).toBe(2)
    expect(sum(ledger, `B7:serial_${group}`)).toBe(0)
    expect(sum(ledger, `B7:prompt_${group}`)).toBe(2 * (10_002 + 11_002))
    expect(count(ledger, `B7:signal:auto:turns_${other}`)).toBe(0)
    expect(sum(ledger, `B7:reqs_${other}`)).toBe(0)
    // The figures of every turn are still the ones for all of them.
    expect(count(ledger, 'S:signal:observe:request_shape')).toBe(2)
    expect(sum(ledger, 'S:shpCalls')).toBe(2)
  })
}

test('/clear goes on in the same session: its half stays, the turns after it are still counted, and the session is not written down twice', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: sessionIn('on') }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await compose($)
  await turn($, options)
  await $.session.end({ reason: 'clear' } as never)
  // The engine may or may not render the prompt again after /clear: the half is the same either way.
  expect(ids((await compose($)).sections)).toEqual(['intro', 'tokenomics:batch-reads'])
  await turn($, options)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B7:fired:auto:session_on')).toBe(1)
  expect(count(ledger, 'B7:signal:auto:turns_on')).toBe(2)
  expect(sum(ledger, 'B7:reqs_on')).toBe(4)
})

test('/clear with no new render of the prompt: the turns after it are counted under the same half', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: sessionIn('off') }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await compose($)
  await turn($, options)
  await $.session.end({ reason: 'clear' } as never)
  await turn($, options)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B7:signal:auto:session_off')).toBe(1)
  expect(count(ledger, 'B7:signal:auto:turns_off')).toBe(2)
  expect(sum(ledger, 'B7:reqs_off')).toBe(4)
})

test('a turn is counted under no half where none was made: before the prompt was composed, or with the sentence not a question', async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: sessionIn('on') }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await turn($, options)
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'B7:reqs_on') + sum(ledger, 'B7:reqs_off')).toBe(0)
  expect(sum(ledger, 'S:shpReqs')).toBe(2)
})

test('set to observe, a turn is counted under no half', { options: { batch: 'observe' } }, async ($, on) => {
  const options: Options = { tmp: '/t', sessionId: sessionIn('on') }
  const calls = engine(on, options)
  on('tool.call', answers)
  await $.session.start(START)
  await compose($)
  await turn($, options)
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'B7:reqs_on') + sum(ledger, 'B7:reqs_off')).toBe(0)
})
