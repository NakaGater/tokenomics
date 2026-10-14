import { type Engine, describe, expect, test } from 'claude-code/testing'

import { requestFlow } from '../hooks/lib/core/flow'
import { append, emptyLedger, parseLedger } from '../hooks/lib/core/ledger'

import { type Calls, SURFACES, answer, bandProps, engine, measure, paneProps, runStep, savedIn, savedLabelIn } from './kit'

describe('what a request is spared by what was kept out of the conversation', () => {
  const kept = [
    { tokens: 10_000, kind: 'digest' as const },
    { tokens: 4_000, kind: 'delegation' as const },
  ]

  test('all of it, by kind', () => {
    expect(requestFlow(kept, 0, 'claude-opus-5-5')).toMatchObject({ digestTokens: 10_000, delegationTokens: 4_000 })
    expect(requestFlow([], 0, 'claude-opus-5-5')).toEqual({ digestTokens: 0, delegationTokens: 0, microUsd: 0 })
  })

  test('the tokens that came out since the last request are priced as a cache write, the others as a read', () => {
    // Opus: 4 dollars a million for a write of five minutes' (5), 0.2 for a read.
    expect(requestFlow(kept, 0, 'claude-opus-5-5').microUsd).toBe(14_000 * 0.2)
    expect(requestFlow(kept, 14_000, 'claude-opus-5-5').microUsd).toBe(14_000 * 5)
    expect(requestFlow(kept, 4_000, 'claude-opus-5-5').microUsd).toBe(4_000 * 5 + 10_000 * 0.2)
    // What is new cannot be more than what is there.
    expect(requestFlow(kept, 99_000, 'claude-opus-5-5').microUsd).toBe(14_000 * 5)
  })

  test('a model that is not in the price list is spared tokens, and no dollars', () => {
    expect(requestFlow(kept, 0, 'some-other-model')).toEqual({ digestTokens: 10_000, delegationTokens: 4_000, microUsd: 0 })
    expect(requestFlow(kept, 0, undefined).microUsd).toBe(0)
  })
})

// ── In the engine ──

type Driver = Engine
type Options = NonNullable<Parameters<typeof engine>[1]>

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const TMP = '/tmp/T'
const DIR = `${TMP}/claude-tokenomics/sess-1`
const AUTO = { options: { digest: 'auto' } } as const

const bash = (stdout: string) =>
  ({ result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: stdout, isReadOnly: true, ref: 1 }) as never
const log = () => Array.from({ length: 2000 }, (_, i) => (i === 1000 ? 'FAIL src/auth.test.ts' : `ok test ${i} ${'x'.repeat(10)}`)).join('\n')
const callBash = ($: Driver, id: string, command = 'bun test') => $.tool.call({ tool: 'Bash', tool_use_id: id, command } as never)

const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}
const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)
const sum = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.sums[key] ?? 0), 0)
const steps = async ($: Driver, n: number, agentId?: string) => {
  for (let i = 0; i < n; i += 1) await runStep($ as never, agentId === undefined ? {} : { agentId })
}
const MESSAGES = [{ role: 'user', text: 'hello', toolUses: [] }] as never

/** What a cut kept out of the conversation, as the ledger says it (once, as it was cut). */
const savedOnce = (ledger: ReturnType<typeof parseLedger>): number => sum(ledger, 'A1:savedTokens')

test('every request that follows a cut is spared it, and the figure grows with the requests', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  const bands = await Promise.all(SURFACES.map(surface => $.ui.mount({ ...bandProps(), surface })))

  await callBash($, 'a')
  await calls.clock.advance(4_000)
  // No request has followed yet: the size as it was cut stands in, under the name it had.
  const once = savedOnce(parseLedger(calls.store.get('ledger:v1')))
  expect(once).toBeGreaterThan(10_000)
  for (const ui of bands) {
    expect(await savedIn(ui)).toBe(`約 ${Math.round(once / 1000)}k tok`)
    expect(await savedLabelIn(ui)).toBe('節約')
  }

  await steps($, 1)
  for (const ui of bands) {
    expect(await savedIn(ui)).toBe(`約 ${Math.round(once / 1000)}k tok`)
    expect(await savedLabelIn(ui)).toBe('節約（延べ）')
  }
  await steps($, 2)
  // Three requests, each sent without it, though the band is not redrawn by the ledger being written: it follows at once.
  for (const ui of bands) expect(await savedIn(ui)).toBe(`約 ${Math.round((3 * once) / 1000)}k tok`)

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:signal:auto:flow')).toBe(3)
  expect(sum(ledger, 'A1:flowTokens')).toBe(3 * once)
  expect(sum(ledger, 'A1:flowKeptTokens')).toBe(0)
  // The first request is spared a cache write of it, the next two a read: dollars, measured on the requests made.
  expect(sum(ledger, 'A1:flowMicroUsd')).toBe(Math.round(once * 5) + 2 * Math.round(once * 0.2))
  // What the cut was stays as it was, for the pilot's report.
  expect(sum(ledger, 'A1:savedTokens')).toBe(once)
})

test('the pane tells the requests and the dollars, and one dollar amount for the cuts', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')
  await steps($, 3)
  await calls.clock.advance(4_000)

  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '今日の節約（合計）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '今日の節約（延べ）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /のべ 3 回のリクエストに載らずに済みました（延べ約 .*入力側の見込み約 \$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /大きな出力を 1 回縮め.*会話に入れずに済みました$/ })).toBeDefined()
})

test('a cut made while a request is coming in was not in that request, and spares the next', AUTO, async ($, on) => {
  const options: Options = { tmp: TMP }
  const calls = engine(on, options)
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  options.duringStep = async () => {
    options.duringStep = undefined
    await callBash($, 'a')
  }
  await steps($, 3)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'A1:signal:auto:flow')).toBe(2)
  expect(sum(ledger, 'A1:flowTokens')).toBe(2 * savedOnce(ledger))
})

test('a request of a subagent is no request of the conversation', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')

  await steps($, 2, 'ag1')
  await steps($, 1)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'A1:signal:auto:flow')).toBe(1)
})

describe('one cut, the output read back, and the command run again', () => {
  test('the saved output is read: that cut spares no more requests', AUTO, async ($, on) => {
    const calls = engine(on, { tmp: TMP })
    on('tool.call', () => bash(log()))
    await $.session.start(START)

    await callBash($, 'a')
    await steps($, 1)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: `${DIR}/out-a.log` } as never)
    await steps($, 2)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, 'A1:signal:auto:flow')).toBe(1)
    expect(count(ledger, 'A1:outcome:auto:readback')).toBe(1)
  })

  test('the command is run again: the new cut spares requests, the old one does not', AUTO, async ($, on) => {
    const calls = engine(on, { tmp: TMP })
    on('tool.call', () => bash(log()))
    await $.session.start(START)

    await callBash($, 'a')
    await steps($, 1)
    await callBash($, 'b')
    await steps($, 2)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, 'A1:outcome:auto:rerun')).toBe(1)
    // One cut in the first request, one (the old one gone) in the next two.
    expect(sum(ledger, 'A1:flowTokens')).toBe(savedOnce(ledger) / 2 + 2 * (savedOnce(ledger) / 2))
  })
})

describe('the window starts over', () => {
  test('/clear: what was kept out of the old conversation spares nothing of the new one, and a new cut starts again', AUTO, async ($, on) => {
    const calls = engine(on, { tmp: TMP })
    on('tool.call', () => bash(log()))
    await $.session.start(START)

    await callBash($, 'a')
    await steps($, 2)
    await $.session.end({ reason: 'clear' } as never)
    await steps($, 3)
    await callBash($, 'b')
    await steps($, 1)
    const ledger = await ledgerOf($, calls)

    // Two requests carried the first cut, one the second: the three requests between spared nothing.
    expect(count(ledger, 'A1:signal:auto:flow')).toBe(3)
    expect(sum(ledger, 'A1:flowTokens')).toBe(3 * (savedOnce(ledger) / 2))
  })

  for (const trigger of ['manual', 'auto'] as const) {
    test(`a compaction (${trigger}): the same`, AUTO, async ($, on) => {
      const calls = engine(on, { tmp: TMP })
      on('tool.call', () => bash(log()))
      await $.session.start(START)

      await callBash($, 'a')
      await steps($, 2)
      await $.session.compact({ trigger, messages: MESSAGES } as never)
      await steps($, 3)
      const ledger = await ledgerOf($, calls)

      expect(count(ledger, 'A1:signal:auto:flow')).toBe(2)
    })
  }

  test('the band’s own button: it does not pass through the plugin’s hooks, so it starts the window over itself', AUTO, async ($, on) => {
    const calls = engine(on, { tmp: TMP, sessionId: 's', messages: [{ role: 'user', text: 'hello', toolUses: [] }] as never, compacted: { tokensBefore: 160_000, tokensAfter: 40_000 } })
    on('tool.call', () => bash(log()))
    await $.session.start(START)

    await callBash($, 'a')
    await steps($, 1)
    await $.session.measure({ ...measure.context(80), rateLimits: [], changed: ['context', 'rateLimits'] as ['context', 'rateLimits'] })
    await answer($ as never, 'accept')
    expect(calls.compacts).toBe(1)
    await steps($, 2)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, 'A1:signal:auto:flow')).toBe(1)
  })

  test('a precompute installs nothing, so what was kept out still is', AUTO, async ($, on) => {
    const calls = engine(on, { tmp: TMP })
    on('tool.call', () => bash(log()))
    await $.session.start(START)

    await callBash($, 'a')
    await steps($, 1)
    await $.session.compact({ trigger: 'precompute', messages: MESSAGES } as never)
    await steps($, 2)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, 'A1:signal:auto:flow')).toBe(3)
  })

  test('a compaction that was skipped changes nothing', { options: { digest: 'auto' } }, async ($, on) => {
    const calls = engine(on, { tmp: TMP, compacted: { skip: 'nothing to do' } })
    on('tool.call', () => bash(log()))
    await $.session.start(START)

    await callBash($, 'a')
    await steps($, 1)
    await $.session.compact({ trigger: 'manual', messages: MESSAGES } as never)
    await steps($, 1)
    const ledger = await ledgerOf($, calls)

    expect(count(ledger, 'A1:signal:auto:flow')).toBe(2)
  })
})

test('an old ledger, with cuts and no requests counted, keeps the band where it was', async ($, on) => {
  const seeded = append(emptyLedger, { kind: 'fired', measure: 'A1', mode: 'auto', arm: 'treat', n: { inChars: 30_000, outChars: 5_000, savedTokens: 8_611, savedMilliUsd: 47 } }, 1_000_000, 'old')
  engine(on, { tmp: TMP, store: { 'ledger:v1': seeded } })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  expect(await savedIn(ui)).toBe('約 8.6k tok')
  expect(await savedLabelIn(ui)).toBe('節約')
})
