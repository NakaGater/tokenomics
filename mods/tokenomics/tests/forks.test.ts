import { type Engine, describe, expect, test } from 'claude-code/testing'

import { MAX_FORKS, forkEnded, forkOutcome, forkRead, forkSet, forkType, forkedId, ownName } from '../hooks/lib/core/forks'
import { parseLedger } from '../hooks/lib/core/ledger'

import { type Calls, SURFACES, bandProps, engine, keptIn, paneProps, savedIn } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

describe('which subagents are the plugin’s own', () => {
  test('its skills’ forks and its agents, not the engine’s, a person’s or its general worker', () => {
    expect(ownName(forkType('scout'))).toBe('scout')
    expect(ownName('fork_test-summary')).toBe('test-summary')
    expect(ownName('fork_log-digest')).toBe('log-digest')
    expect(ownName('tokenomics:scout')).toBe('scout')
    expect(ownName('tokenomics:test-runner')).toBe('test-runner')
    for (const other of ['fork_deploy', 'fork_', 'Explore', 'general-purpose', 'custom', 'plugin', 'tokenomics:light-worker', 'scout', 'other:scout']) {
      expect(ownName(other)).toBeNull()
    }
  })

  test('a forked skill names its subagent in the answer; anything else names none', () => {
    expect(forkedId({ success: true, commandName: 'scout', status: 'forked', agentId: 'a1', result: 'r' })).toBe('a1')
    expect(forkedId({ success: true, commandName: 'scout', status: 'inline' })).toBeNull()
    expect(forkedId({ status: 'forked', agentId: '' })).toBeNull()
    expect(forkedId({ status: 'forked' })).toBeNull()
    expect(forkedId('Skill "scout" completed')).toBeNull()
    expect(forkedId(null)).toBeNull()
    expect(forkedId(undefined)).toBeNull()
  })
})

describe('what a run kept out of the conversation', () => {
  const ended = { reportTokens: 300, spent: 1_000, isReader: true, turn: 2 }

  test('what its tool results held, less its report', () => {
    const run = forkEnded(forkRead(forkRead(undefined, 6_000), 4_000), ended)
    expect(forkOutcome(run, 'fork_scout')).toEqual({ name: 'scout', readTokens: 10_000, reportTokens: 300, keptTokens: 9_700, runMicroUsd: null, isLoss: false })
    expect(forkOutcome(forkEnded(forkRead(undefined, 10_000), { ...ended, microUsd: 1_250 }), 'fork_scout')?.runMicroUsd).toBe(1_250)
    expect(forkOutcome(run, 'tokenomics:scout')?.keptTokens).toBe(9_700)
  })

  test('never below nothing: a report longer than what was read keeps out zero', () => {
    const run = forkEnded(forkRead(undefined, 100), ended)
    expect(forkOutcome(run, 'fork_scout')?.keptTokens).toBe(0)
    // And the run is told apart as one that gained nothing (a report as large as what it read is no gain either).
    expect(forkOutcome(run, 'fork_scout')?.isLoss).toBe(true)
    expect(forkOutcome(forkEnded(forkRead(undefined, 300), ended), 'fork_scout')?.isLoss).toBe(true)
    expect(forkOutcome(forkEnded(forkRead(undefined, 301), ended), 'fork_scout')?.isLoss).toBe(false)
  })

  test('nothing until the run has ended, and nothing for a kind that is not the plugin’s', () => {
    expect(forkOutcome(forkRead(undefined, 5_000), 'fork_scout')).toBeNull()
    expect(forkOutcome(forkEnded(forkRead(undefined, 5_000), ended), 'Explore')).toBeNull()
  })

  test('a negative or fractional size is made whole', () => {
    expect(forkRead(undefined, -5).readTokens).toBe(0)
    expect(forkRead(undefined, 2.6).readTokens).toBe(3)
  })

  test('only the latest runs are remembered', () => {
    let runs = new Map<string, ReturnType<typeof forkRead>>()
    for (let i = 0; i < MAX_FORKS + 5; i += 1) runs = forkSet(runs, `a${i}`, forkRead(undefined, i))
    expect(runs.size).toBe(MAX_FORKS)
    expect(runs.has('a0')).toBe(false)
    expect(runs.has(`a${MAX_FORKS + 4}`)).toBe(true)
  })
})

type Driver = Engine

const SMALL = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'claude-opus-5-5' }

const text = (chars: number) => 'x'.repeat(chars)

/** What the engine answers a tool with; a Skill call that forks answers as the real engine does (probe on 2.1.295). */
const answers = (forked: Record<string, string>, reads: number) => (_$: unknown, e: { tool: unknown; skill?: unknown }) => {
  if (e.tool === 'Skill') {
    const id = forked[String(e.skill)]
    if (id === undefined) return { result: { success: true, commandName: String(e.skill), status: 'inline' }, text: 'inline', isReadOnly: false, ref: 1 } as never
    return {
      result: { success: true, commandName: String(e.skill), status: 'forked', agentId: id, result: 'report' },
      text: 'Skill "x" completed (forked execution).  Result: report',
      isReadOnly: false,
      ref: 1,
    } as never
  }
  return { result: { type: 'text' }, text: text(reads), isReadOnly: true, ref: 1 } as never
}

const read = ($: Driver, id: string, path: string, agentId: string) =>
  $.tool.call({ tool: 'Read', tool_use_id: id, file_path: path, agentId } as never)

const skill = ($: Driver, id: string, name: string) => $.tool.call({ tool: 'Skill', tool_use_id: id, skill: name } as never)

const subEnds = ($: Driver, agentId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `${agentId}-t`, reason: 'answer', agentId, usage: { ...SMALL, input_tokens: 100, output_tokens: 100 } } as never)

const mainEnds = ($: Driver, id: string) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage: SMALL } as never)

const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}

const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)
const sum = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.sums[key] ?? 0), 0)

// 30 000 characters are 10 000 tokens; 600 are 200.
const BIG = 30_000
const REPORT = text(600)

test('a skill’s fork ends before the Skill call returns: it is named then, and what it kept out is counted', async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({ 'tokenomics:scout': 'f1' }, BIG))
  await $.session.start(START)
  await mainEnds($, 'warm') // learns the main model, so that dollars can be put to it

  await read($, 'r1', '/repo/src/a.ts', 'f1')
  await read($, 'r2', '/repo/src/b.ts', 'f1')
  await subEnds($, 'f1', REPORT)
  await skill($, 's1', 'tokenomics:scout')
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B1:signal:observe:kept_scout')).toBe(1)
  expect(sum(ledger, 'B1:readTokens')).toBe(20_000)
  expect(sum(ledger, 'B1:reportTokens')).toBe(200)
  expect(sum(ledger, 'B1:keptTokens')).toBe(19_800)
  expect(sum(ledger, 'B1:keptMilliUsd')).toBeGreaterThan(0)
  // What the run itself cost: its usage (100 fresh and 5,000 cache-read tokens on opus, 4 and 0.2 dollars a million) is $0.0014.
  expect(sum(ledger, 'B1:scoutMicroUsd')).toBe(1_400)
  expect(count(ledger, 'B1:outcome:observe:lost_fork_scout')).toBe(0)
  // The fork is a kind of its own, with what it spent and whether it read.
  expect(count(ledger, 'B1:signal:observe:fork_scout')).toBe(1)
  expect(sum(ledger, 'B1:spent')).toBe(200)
  expect(count(ledger, 'B1:signal:observe:readers_fork_scout')).toBe(1)
  expect(count(ledger, 'B1:signal:observe:readers_custom')).toBe(0)
  // Counts and sums, never the work.
  const written = JSON.stringify(calls.store.get('ledger:v1'))
  expect(written).not.toContain('/repo')
  expect(written).not.toContain('a.ts')
})

test('a run whose report is as large as what it read is paid for and counted as a loss, not as a gain', async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({ 'tokenomics:scout': 'f1' }, 90))
  await $.session.start(START)
  await mainEnds($, 'warm')

  await read($, 'r1', '/repo/src/a.ts', 'f1')
  await subEnds($, 'f1', REPORT)
  await skill($, 's1', 'tokenomics:scout')
  const ledger = await ledgerOf($, calls)

  // 90 characters are 30 tokens, the report 200: nothing was kept out, and the run still cost.
  expect(sum(ledger, 'B1:keptTokens')).toBe(0)
  expect(sum(ledger, 'B1:scoutMicroUsd')).toBe(1_400)
  expect(count(ledger, 'B1:outcome:observe:lost_fork_scout')).toBe(1)
})

test('a fork that was named before it ended is counted when it ends; the name without the plugin’s in front works too', async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({ 'test-summary': 'f2' }, BIG))
  await $.session.start(START)
  await mainEnds($, 'warm')

  await skill($, 's1', 'test-summary')
  await read($, 'r1', '/repo/a.ts', 'f2')
  await subEnds($, 'f2', REPORT)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B1:signal:observe:kept_test-summary')).toBe(1)
  expect(sum(ledger, 'B1:keptTokens')).toBe(10_000 - 200)
})

test('the plugin’s agent, spawned by name, is counted the same way', async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({}, BIG))
  on('agent.spawn', (_$, e) => ({ model: String(e.model ?? e.parentModel), agentId: 'ag1' }))
  await $.session.start(START)
  await mainEnds($, 'warm')

  await $.agent.spawn({ prompt: 'p', description: 'where is the handler', subagentType: 'tokenomics:scout', tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false } as never)
  await read($, 'r1', '/repo/a.ts', 'ag1')
  await subEnds($, 'ag1', REPORT)
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B1:signal:observe:kept_scout')).toBe(1)
  expect(count(ledger, 'B1:signal:observe:tokenomics:scout')).toBe(1)
  expect(sum(ledger, 'B1:keptTokens')).toBe(10_000 - 200)
})

test('what the engine’s own agents and a person’s skills do is not credited to the plugin', async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({ deploy: 'f3' }, BIG))
  on('agent.spawn', (_$, e) => ({ model: String(e.model ?? e.parentModel), agentId: 'ag2' }))
  await $.session.start(START)
  await mainEnds($, 'warm')

  await $.agent.spawn({ prompt: 'p', description: 'find the handler', subagentType: 'Explore', tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false } as never)
  await read($, 'r1', '/repo/a.ts', 'ag2')
  await subEnds($, 'ag2', REPORT)
  await read($, 'r2', '/repo/b.ts', 'f3')
  await subEnds($, 'f3', REPORT)
  await skill($, 's1', 'deploy')
  await mainEnds($, 'next')
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'B1:keptTokens')).toBe(0)
  expect(count(ledger, 'B1:signal:observe:kept_scout')).toBe(0)
  // The engine’s agent is still a reader of its own kind; the person’s skill, never named, is `custom`.
  expect(count(ledger, 'B1:signal:observe:readers_Explore')).toBe(1)
  expect(count(ledger, 'B1:signal:observe:readers_custom')).toBe(1)
})

test('a report longer than what was read keeps out nothing, and is still a run', async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({ scout: 'f4' }, 90))
  await $.session.start(START)
  await mainEnds($, 'warm')

  await read($, 'r1', '/repo/a.ts', 'f4')
  await subEnds($, 'f4', REPORT)
  await skill($, 's1', 'scout')
  const ledger = await ledgerOf($, calls)

  expect(count(ledger, 'B1:signal:observe:kept_scout')).toBe(1)
  expect(sum(ledger, 'B1:keptTokens')).toBe(0)
  expect(sum(ledger, 'B1:readTokens')).toBe(30)
})

test('a Skill call the engine turned away, or one that did not fork, names no subagent', async ($, on) => {
  const calls = engine(on)
  let mode: 'error' | 'inline' = 'error'
  on('tool.call', (_$, e) => {
    if (e.tool !== 'Skill') return { result: { type: 'text' }, text: text(BIG), isReadOnly: true, ref: 1 } as never
    if (mode === 'error') return { isError: true, result: 'disable-model-invocation', text: 'disable-model-invocation' } as never
    return { result: { success: true, commandName: 'scout', status: 'inline' }, text: 'inline', isReadOnly: false, ref: 1 } as never
  })
  await $.session.start(START)
  await mainEnds($, 'warm')

  await read($, 'r1', '/repo/a.ts', 'f5')
  await subEnds($, 'f5', REPORT)
  await skill($, 's1', 'scout')
  mode = 'inline'
  await skill($, 's2', 'scout')
  await mainEnds($, 'next')
  const ledger = await ledgerOf($, calls)

  expect(sum(ledger, 'B1:keptTokens')).toBe(0)
  expect(count(ledger, 'B1:signal:observe:readers_custom')).toBe(1)
})

test('delegation off: no figure', { options: { delegation: 'off' } }, async ($, on) => {
  const calls = engine(on)
  on('tool.call', answers({ scout: 'f7' }, BIG))
  await $.session.start(START)
  await mainEnds($, 'warm')

  await read($, 'r1', '/repo/a.ts', 'f7')
  await subEnds($, 'f7', REPORT)
  await skill($, 's1', 'scout')
  const ledger = await ledgerOf($, calls)
  expect(sum(ledger, 'B1:keptTokens')).toBe(0)
  expect(count(ledger, 'B1:signal:off:kept_scout')).toBe(0)
})

// ── What the person sees ──────────────────────────────────────────────────────────────────────────────────────

const RUN = { command: 'tokenomics', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

/** What the engine answers, said before the test first calls `$`. */
const scoutForks = (on: Parameters<typeof engine>[0]) => on('tool.call', answers({ 'tokenomics:scout': 'f1' }, BIG))

/** A skill of the plugin forks, reads 20 000 tokens and hands back 200, and the ledger is written out. */
const handOver = async ($: Driver, calls: Calls) => {
  await $.session.start(START)
  await mainEnds($, 'warm')
  await read($, 'r1', '/repo/src/a.ts', 'f1')
  await read($, 'r2', '/repo/src/b.ts', 'f1')
  await subEnds($, 'f1', REPORT)
  await skill($, 's1', 'tokenomics:scout')
  await calls.clock.advance(4_000)
}

test('the pane tells the estimate in a row of its own, called an estimate', async ($, on) => {
  const calls = engine(on)
  scoutForks(on)
  await handOver($, calls)

  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '今日の節約（推定）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /調べものやテストを 1 回任せ.*約 20k tok（控えめな推定）/ })).toBeDefined()
  // No cut was made, so there is no row for one, and nothing is added up.
  expect(await pane.find({ type: 'Text', text: '今日の節約（確定）' })).toBeUndefined()
})

test('the text report says it too', async ($, on) => {
  const calls = engine(on, { isPlaced: false })
  scoutForks(on)
  await handOver($, calls)

  const ran = await $.command.run(RUN as never)
  expect(ran.text).toContain('今日の節約（推定）')
  expect(ran.text).toContain('控えめな推定')
})

test('the band shows it beside its own label, never in the figure of the cuts', async ($, on) => {
  const calls = engine(on)
  scoutForks(on)
  const bands = await Promise.all(SURFACES.map(surface => $.ui.mount({ ...bandProps(), surface })))
  for (const ui of bands) expect(await keptIn(ui)).toBeUndefined()
  await handOver($, calls)

  for (const ui of bands) {
    expect(await keptIn(ui)).toBe('約 20k tok')
    expect(await savedIn(ui)).toBeUndefined()
  }
})

test('a person held back from the savings is not shown the estimate, though the ledger keeps it for the comparison', { options: { holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on, { isPlaced: false })
  scoutForks(on)
  const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  await handOver($, calls)

  expect(await keptIn(band)).toBeUndefined()
  const ran = await $.command.run(RUN as never)
  expect(ran.text).not.toContain('任せ')
  expect(sum(await ledgerOf($, calls), 'B1:keptTokens')).toBe(19_800)
})
