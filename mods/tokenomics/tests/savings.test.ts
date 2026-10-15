import { type Engine, expect, test } from 'claude-code/testing'

import { DEMO_LINE, DEMO_SHORT } from '../hooks/lib/core/nudges'
import { type Ledger, append, emptyLedger, parseLedger, retiredNudges, savingsToday } from '../hooks/lib/core/ledger'

import { type Calls, SURFACES, bandProps, engine, measure, nudgeIn, paneProps, phraseIn, runStep, savedIn, savedLabelIn } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const TMP = '/tmp/T'
const DIR = `${TMP}/claude-tokenomics/sess-1`
const DIALOG = 'tokenomics-offer'
const RUN = { command: 'tokenomics', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

type Driver = Engine

const bash = (stdout: string) =>
  ({ result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: stdout, isReadOnly: true, ref: 1 }) as never

const log = (failAt = 1000) =>
  Array.from({ length: 2000 }, (_, i) => (i === failAt ? 'FAIL src/auth.test.ts > rejects a bad password' : `ok test ${i} ${'x'.repeat(10)}`)).join('\n')

type Ran = { text: string; result: { stdout: string } }

const callBash = ($: Driver, id: string, command = 'bun test') => $.tool.call({ tool: 'Bash', tool_use_id: id, command } as never) as unknown as Promise<Ran>

const ask = ($: Driver, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

const SMALL = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'claude-opus-5-5' }
const done = ($: Driver, id: string, usage = SMALL) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage } as never)

/** The session ends, which writes the ledger out; what the store then holds. */
const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}

const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)

const sum = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.sums[key] ?? 0), 0)

const dialogs = (calls: Calls): number => calls.opened.filter(id => id === DIALOG).length

const AUTO = { options: { digest: 'auto' } } as const

test('the digest: a big command output reaches the model cut down, with the full text saved beside the handoff notes', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  const ran = await callBash($, 'toolu_1')
  expect(ran.text).toContain('tokenomics shortened this output')
  expect(ran.text).toContain(`${DIR}/out-toolu_1.log`)
  expect(ran.text).toContain('FAIL src/auth.test.ts > rejects a bad password')
  expect(ran.text.length).toBeLessThan(out.length / 5)
  // What the model reads in the result and in the text is the same.
  expect(ran.result.stdout).toBe(ran.text)
  expect(calls.writes.find(w => w.path === `${DIR}/out-toolu_1.log`)?.text).toBe(out)

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:fired:auto')).toBe(1)
  expect(sum(ledger, 'A1:savedTokens')).toBeGreaterThan(10_000)
})

test('set to observe, the digest only watches: the output is as it was, and the ledger says it would have been cut', { options: { digest: 'observe' } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  const ran = await callBash($, 'toolu_1')
  expect(ran.text).toBe(out)
  expect(calls.writes.filter(w => w.path.includes('out-toolu_1'))).toEqual([])
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:would:observe')).toBe(1)
  expect(count(ledger, 'A1:fired:auto')).toBe(0)
})

test('a small output, and the output of any other tool, are left alone', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? bash('ok') : ({ result: { type: 'text' }, text: log(), isReadOnly: true, ref: 1 }) as never))
  await $.session.start(START)

  expect((await callBash($, 'a')).text).toBe('ok')
  const read = (await $.tool.call({ tool: 'Read', tool_use_id: 'b', file_path: '/repo/big.ts' } as never)) as unknown as Ran
  expect(read.text).toBe(log())
  expect(calls.writes.filter(w => w.path.includes('claude-tokenomics'))).toEqual([])
})

test('if the full text cannot be saved, the output is left as it was: nothing is cut that cannot be got back', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP, isWriteBroken: true })
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  const ran = await callBash($, 'toolu_1')
  expect(ran.text).toBe(out)
  expect(count(await ledgerOf($, calls), 'A1:error:observe')).toBe(1)
})

test('a measure that keeps failing stops after three, and the work goes on as it was', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP, isWriteBroken: true })
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  for (let i = 0; i < 6; i += 1) expect((await callBash($, `t${i}`)).text).toBe(out)
  expect(count(await ledgerOf($, calls), 'A1:error:observe')).toBe(3)
})

test('off: nothing is cut and nothing is noted', { options: { digest: 'off' } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  expect((await callBash($, 'a')).text).toBe(out)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:would:observe') + count(ledger, 'A1:fired:auto')).toBe(0)
})

test('a person in the held-back share gets no digest, only the note that it would have been made', { options: { digest: 'auto', holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  expect((await callBash($, 'a')).text).toBe(out)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:would:observe')).toBe(1)
  expect(ledger.recent.every(r => r.arm === 'control')).toBe(true)
})

test('what the digest cut is not counted as large: the model never read it', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  await callBash($, 'toolu_1')
  await ask($, 'run the tests')
  await done($, 't1')
  // The raw log is 20k tokens; cut, it is nowhere near the size that calls for a suggestion about it.
  expect(dialogs(calls)).toBe(0)
})

test('without a temp folder of the person’s own (no TMPDIR) the digest only watches: copies would land in a shared /tmp', AUTO, async ($, on) => {
  const calls = engine(on)
  const out = log()
  on('tool.call', () => bash(out))
  await $.session.start(START)

  expect((await callBash($, 'a')).text).toBe(out)
  expect(calls.writes.filter(w => w.path.includes('claude-tokenomics'))).toEqual([])
  expect(count(await ledgerOf($, calls), 'A1:would:observe')).toBe(1)
})

test('a subagent’s big output is cut too, and the model may read it back without being asked', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  on('tool.check', () => ({ decision: 'ask', reason: 'needs permission' }))
  await $.session.start(START)

  const ran = (await $.tool.call({ tool: 'Bash', tool_use_id: 'sub_1', command: 'bun test', agentId: 'ag1' } as never)) as unknown as Ran
  expect(ran.text).toContain('tokenomics shortened this output')
  const check = await $.tool.check({ tool: 'Read', input: { file_path: `${DIR}/out-sub_1.log` } } as never)
  expect(check.decision).toBe('allow')
  expect(calls.writes.some(w => w.path === `${DIR}/out-sub_1.log`)).toBe(true)
})

test('a subagent’s cut is not in the confirmed figure: the conversation would never have read that output', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'sub_1', command: 'bun test', agentId: 'ag1' } as never)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:fired:auto')).toBe(0)
  expect(sum(ledger, 'A1:savedTokens')).toBe(0)
  expect(sum(ledger, 'A1:savedMilliUsd')).toBe(0)
  expect(count(ledger, 'A1:signal:auto:sub_cut')).toBe(1)
  expect(sum(ledger, 'A1:subSavedTokens')).toBeGreaterThan(10_000)
  expect(savingsToday(ledger, 1_000_000)).toMatchObject({ digests: 0, tokens: 0, milliUsd: 0 })
})

test('a subagent running the command the conversation had cut, or reading the saved file, is not the conversation going back', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  await callBash($, 'toolu_1')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'sub_1', command: 'bun test', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'sub_r', file_path: `${DIR}/out-toolu_1.log`, agentId: 'ag1' } as never)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:outcome:auto:rerun')).toBe(0)
  expect(count(ledger, 'A1:outcome:auto:readback')).toBe(0)
})

test('reading is allowed only for the saved outputs, only when it would have asked, and a refusal stands', AUTO, async ($, on) => {
  engine(on, { tmp: TMP })
  let verdict: 'ask' | 'deny' | 'allow' = 'ask'
  on('tool.check', () => ({ decision: verdict, reason: 'because' }))
  await $.session.start(START)

  const check = (file_path: string, tool = 'Read') => $.tool.check({ tool, input: { file_path } } as never)
  expect((await check(`${DIR}/out-a.log`)).decision).toBe('allow')
  expect((await check(`${DIR}/out-a.log`, 'Edit')).decision).toBe('ask')
  expect((await check('/etc/passwd')).decision).toBe('ask')
  expect((await check(`${DIR}/../sess-2/out-a.log`)).decision).toBe('ask')
  expect((await check(`${TMP}/claude-tokenomics/sess-10/out-a.log`)).decision).toBe('ask')
  expect((await check(`${DIR}-x/out-a.log`)).decision).toBe('ask')

  verdict = 'deny'
  expect((await check(`${DIR}/out-a.log`)).decision).toBe('deny')
  verdict = 'allow'
  expect((await check('/etc/passwd')).decision).toBe('allow')
})

test('while the digest only watches, nothing is let through', { options: { digest: 'observe' } }, async ($, on) => {
  engine(on, { tmp: TMP })
  on('tool.check', () => ({ decision: 'ask', reason: 'because' }))
  await $.session.start(START)

  expect((await $.tool.check({ tool: 'Read', input: { file_path: `${DIR}/out-a.log` } } as never)).decision).toBe('ask')
})

test('the model going back for what was cut is noted: the same command again, or a read of the saved file', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? bash(log()) : ({ result: { type: 'text' }, text: 'line', isReadOnly: true, ref: 1 }) as never))
  await $.session.start(START)

  await callBash($, 'a', 'bun   test')
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/repo/other.ts' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: `${DIR}/out-a.log` } as never)
  await callBash($, 'b', 'bun test')

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:outcome:auto:readback')).toBe(1)
  expect(count(ledger, 'A1:outcome:auto:rerun')).toBe(1)
})

test('the ledger keeps counts and numbers, never the work: no path, command, prompt or session id', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP, sessionId: '9a9a7245-c2fa-4aba-b67d-45ab91e98e59' })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await ask($, '別件ですが、/repo/secret/plan.md の件をお願いします')
  await callBash($, 'toolu_secret', 'cat /repo/secret/keys.txt')
  await done($, 't1')

  await ledgerOf($, calls)
  const written = JSON.stringify(calls.store.get('ledger:v1'))
  expect(written.length).toBeGreaterThan(50)
  for (const private_ of ['/repo', 'secret', 'keys.txt', 'plan.md', '別件', '9a9a7245', 'toolu_secret', 'bun test']) expect(written).not.toContain(private_)
  // The person is known by a stored id and the arm by a hash; neither is the session’s own.
  expect(typeof calls.store.get('personId')).toBe('string')
  expect(String(calls.store.get('personId'))).not.toContain('9a9a7245')
})

test('events are added to what the store already holds, so another session’s are kept', AUTO, async ($, on) => {
  const first = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')
  const ledger = await ledgerOf($, first)
  expect(count(ledger, 'A1:fired:auto')).toBe(1)

  // The store changes under it: another session has written meanwhile.
  first.store.set('ledger:v1', { ...ledger, days: ledger.days.map(d => ({ ...d, counts: { ...d.counts, 'A1:fired:auto': 5 } })) })
  await callBash($, 'b')
  expect(count(await ledgerOf($, first), 'A1:fired:auto')).toBe(6)
})

test('a subagent of a listed kind is lowered when the setting says so: lighter model, lower effort', { options: { digest: 'off', delegation: 'auto' } }, async ($, on) => {
  const calls = engine(on)
  const seen: { spawn?: Record<string, unknown>; call?: Record<string, unknown> } = {}
  on('tool.call', (_$, e) => {
    seen.call = e as unknown as Record<string, unknown>
    return { result: { type: 'text' }, text: 'started', isReadOnly: true, ref: 1 } as never
  })
  on('agent.spawn', (_$, e) => {
    seen.spawn = e as unknown as Record<string, unknown>
    return { model: String(e.model ?? e.parentModel), agentId: 'ag1' }
  })
  await $.session.start(START)
  await runStep($, { model: 'claude-opus-5-5' })

  await $.tool.call({ tool: 'Agent', tool_use_id: 'a1', description: 'find the login handler', prompt: 'p', subagent_type: 'Explore' } as never)
  expect(seen.call?.effort).toBe('low')

  const spawn = (over: Record<string, unknown>) =>
    $.agent.spawn({
      prompt: 'p',
      description: 'find the login handler',
      subagentType: 'Explore',
      tool_use_id: 'a1',
      parentModel: 'claude-opus-5-5',
      fork: false,
      background: true,
      ...over,
    } as never)
  await spawn({})
  expect(seen.spawn?.model).toBe('sonnet')
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B1:fired:auto:sonnet')).toBe(1)
  expect(count(ledger, 'B2:fired:auto:Explore')).toBe(1)
})

test('what is not listed, a fork, a teammate, a named model or an explicit effort is left alone; every spawn is still noted', { options: { digest: 'off', delegation: 'auto' } }, async ($, on) => {
  const calls = engine(on)
  const spawned: Record<string, unknown>[] = []
  const called: Record<string, unknown>[] = []
  on('tool.call', (_$, e) => {
    called.push(e as unknown as Record<string, unknown>)
    return { result: { type: 'text' }, text: 'started', isReadOnly: true, ref: 1 } as never
  })
  on('agent.spawn', (_$, e) => {
    spawned.push(e as unknown as Record<string, unknown>)
    return { model: String(e.model ?? e.parentModel), agentId: `ag${spawned.length}` }
  })
  await $.session.start(START)
  await runStep($, { model: 'claude-opus-5-5' })

  const spawn = (over: Record<string, unknown>) =>
    $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'Explore', tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false, ...over } as never)
  await spawn({ subagentType: 'general-purpose' })
  await spawn({ fork: true })
  await spawn({ isTeammate: true })
  await spawn({ model: 'opus' })
  await spawn({ parentModel: 'claude-sonnet-5-5' })
  expect(spawned.map(s => s.model)).toEqual([undefined, undefined, undefined, 'opus', undefined])

  await $.tool.call({ tool: 'Agent', tool_use_id: 'x1', description: 'd', prompt: 'p', subagent_type: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'x2', description: 'd', prompt: 'p', subagent_type: 'Explore', effort: 'high' } as never)
  expect(called.map(c => c.effort)).toEqual([undefined, 'high'])
  expect(count(await ledgerOf($, calls), 'B1:signal:auto:general-purpose_opus')).toBe(1)
})

test('by default a subagent is only watched: the spawn is as it was, and the ledger says what would have been done', async ($, on) => {
  const calls = engine(on)
  let seen: Record<string, unknown> = {}
  on('agent.spawn', (_$, e) => {
    seen = e as unknown as Record<string, unknown>
    return { model: String(e.model ?? e.parentModel), agentId: 'ag1' }
  })
  await $.session.start(START)

  await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'Explore', tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false } as never)
  expect(seen.model).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B1:would:observe:sonnet')).toBe(1)
  expect(count(ledger, 'B3:would:observe:Explore')).toBe(1)
})

test('asking for the same thing again soon is not lowered, and what a subagent spends is counted by kind', { options: { digest: 'off', delegation: 'auto' } }, async ($, on) => {
  const calls = engine(on)
  const models: unknown[] = []
  on('agent.spawn', (_$, e) => {
    models.push(e.model)
    return { model: String(e.model ?? e.parentModel), agentId: 'ag1' }
  })
  await $.session.start(START)
  const spawn = () =>
    $.agent.spawn({ prompt: 'p', description: 'find where the login handler is defined', subagentType: 'Explore', tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false } as never)
  await spawn()
  await spawn()
  expect(models).toEqual(['sonnet', undefined])

  await $.turn.complete({ answer: 'r', durationMs: 1, isAborted: false, turnId: 'ag1-t', reason: 'answer', agentId: 'ag1', usage: { ...SMALL, input_tokens: 1_000, output_tokens: 500 } } as never)
  expect(sumOf(await ledgerOf($, calls), 'B1:spent')).toBe(1_500)
})

const sumOf = (ledger: ReturnType<typeof parseLedger>, key: string): number => sum(ledger, key)

test('a change of subject in a big conversation is noted as a suggestion that would have been made; a small one, a command and what is sent in are not', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(40))

  await ask($, '別件ですが、請求書のPDF出力を作ってください')
  await $.prompt.submit({ text: '別件ですが、これは別の人から', wait: false, origin: { kind: 'peer' } } as never)
  await $.prompt.submit({ text: '/clear 別件', wait: false, origin: { kind: 'composer' } } as never)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C1:would:observe:keyword')).toBe(1)
  expect(ledger.recent.filter(r => r.measure === 'C1' && r.kind === 'would')).toHaveLength(1)
})

test('a small conversation is not worth a suggestion', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(5))
  await ask($, '別件ですが、請求書のPDF出力を作ってください')
  expect(count(await ledgerOf($, calls), 'C1:would:observe:keyword')).toBe(0)
})

test('a conversation that grows heavy is noted once at each level, by what a turn costs to read it', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  await $.session.measure(measure.context(30))
  await $.session.measure(measure.context(55))
  await $.session.measure(measure.context(60))
  await $.session.measure(measure.context(100))
  await $.session.measure(measure.context(30))
  await $.session.measure(measure.context(55))
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C2:would:observe:notice')).toBe(2)
  expect(count(ledger, 'C2:would:observe:strong')).toBe(1)
})

test('a prompt after a pause longer than the cache lives, on a big conversation, is noted with what the lapse costs', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(40))
  await ask($, 'continue')
  await done($, 't1')

  await calls.clock.advance(10 * 60_000)
  await ask($, 'continue')
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C3:would:observe:50to100k')).toBe(1)
  expect(count(ledger, 'S:signal:observe:idle_5to15m_50to100k')).toBe(1)
  expect(sum(ledger, 'C3:penaltyMilliUsd')).toBeGreaterThan(0)
})

test('on a subscription the cache lives an hour: ten minutes away is no lapse, seventy is', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const subscription = { ...measure.context(40), rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['context', 'rateLimits'] as ['context', 'rateLimits'] }
  await $.session.measure(subscription)
  await ask($, 'continue')
  await done($, 't1')

  await calls.clock.advance(10 * 60_000)
  await ask($, 'continue')
  await done($, 't2')
  expect(count(await ledgerOf($, calls), 'C3:would:observe:50to100k')).toBe(0)

  await calls.clock.advance(70 * 60_000)
  await ask($, 'continue')
  expect(count(await ledgerOf($, calls), 'C3:would:observe:50to100k')).toBe(1)
})

test('a turn that comes after a pause and writes its prompt into the cache again is noted as a cold return', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await ask($, 'first')
  await done($, 't1')
  await calls.clock.advance(10 * 60_000)
  await ask($, 'second')
  await done($, 't2', { ...SMALL, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 60_000 })

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'S:signal:observe:cold_50to100k')).toBe(1)
  // 61,100 tokens written at $5 a million: $0.3055.
  expect(sum(ledger, 'S:costMilliUsd')).toBe(306)
  expect(count(ledger, 'S:signal:observe:turn')).toBe(2)
  // Each turn's prompt is summed once: the cold turn's own record keeps its prompt under another name.
  expect(sum(ledger, 'S:prompt')).toBe(5_100 + 61_100)
  expect(sum(ledger, 'S:coldPrompt')).toBe(61_100)
})

test('a fresh start soon after a suggestion that would have been made is counted as the answer', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(40))
  await ask($, '別件ですが、請求書のPDF出力を作ってください')
  await $.session.end({ reason: 'clear' } as never)

  expect(count(await ledgerOf($, calls), 'C1:accepted:observe:self')).toBe(1)
})

test('/tokenomics good and bad leave a thumb in the ledger and nothing of the work', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  const ran = await $.command.run({ ...RUN, args: 'good' } as never)
  expect(ran.text).toContain('記録しました')
  await $.command.run({ ...RUN, args: ' Bad ' } as never)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'S:feedback:observe:good')).toBe(1)
  expect(count(ledger, 'S:feedback:observe:bad')).toBe(1)
  // Without a word it opens the pane, as before.
  await $.command.run(RUN as never)
  expect(calls.opened).toContain('tokenomics')
})

test('with the hud off nothing is drawn and no suggestion is put, but the savings go on', { options: { hud: false, digest: 'auto' } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await $.session.measure(measure.context(78))
  expect(dialogs(calls)).toBe(0)
  const ran = await $.command.run(RUN as never)
  expect(ran.text).toContain('トークン消費')
  expect(calls.opened).toEqual([])

  expect((await callBash($, 'a')).text).toContain('tokenomics shortened this output')
})

test('the ledger is written out in a moment, and when the session ends', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')
  expect(calls.store.get('ledger:v1')).toBeUndefined()

  await calls.clock.advance(4_000)
  expect(count(parseLedger(calls.store.get('ledger:v1')), 'A1:fired:auto')).toBe(1)
})

test('the pane says what was saved today, in tokens and, off a subscription, in dollars', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')
  await calls.clock.advance(4_000)

  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /大きな出力を 1 回縮め/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /見込み約 \$/ })).toBeDefined()
})

test('on a subscription the same row has no dollars in it', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await $.session.measure({ ...measure.context(10), rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['context', 'rateLimits'] as ['context', 'rateLimits'] })
  await callBash($, 'a')
  await calls.clock.advance(4_000)

  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /大きな出力を 1 回縮め/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /見込み約/ })).toBeUndefined()
})

test('the text report, for a terminal too narrow for a pane, says it too', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP, isPlaced: false })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')
  await calls.clock.advance(4_000)

  const ran = await $.command.run(RUN as never)
  expect(ran.text).toContain('今日の節約')
  expect(ran.text).toContain('大きな出力を 1 回縮め')
})

test('the band says what the digest has kept out of the conversation today, on the card and on the plain row', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  const bands = await Promise.all(SURFACES.map(surface => $.ui.mount({ ...bandProps(), surface })))
  for (const ui of bands) expect(await savedIn(ui)).toBeUndefined()

  await callBash($, 'a')
  await calls.clock.advance(4_000)

  const saved = sum(parseLedger(calls.store.get('ledger:v1')), 'A1:savedTokens')
  expect(saved).toBeGreaterThan(10_000)
  for (const ui of bands) expect(await savedIn(ui)).toBe(`約 ${Math.round(saved / 1000)}k tok`)
})

test('the band adds up every kind of saving in one figure, and the pane tells them apart', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)

  const bands = await Promise.all(SURFACES.map(surface => $.ui.mount({ ...bandProps(), surface })))
  await callBash($, 'a')
  await calls.clock.advance(4_000)
  // The session's row names the figure the same whatever is in it; the pane says which kinds are.
  for (const ui of bands) expect(await savedLabelIn(ui)).toBe('節約（延べ）')

  await $.tool.call({ tool: 'Bash', tool_use_id: 'sub_1', command: 'bun test', agentId: 'ag1' } as never)
  await calls.clock.advance(4_000)

  const ledger = parseLedger(calls.store.get('ledger:v1'))
  const confirmed = sum(ledger, 'A1:savedTokens')
  const inSubagent = sum(ledger, 'A1:subSavedTokens')
  expect(confirmed).toBeGreaterThan(10_000)
  expect(inSubagent).toBeGreaterThan(10_000)
  for (const ui of bands) {
    expect(await savedIn(ui)).toBe(`約 ${Math.round((confirmed + inSubagent) / 1000)}k tok`)
    expect(await savedLabelIn(ui)).toBe('節約（延べ）')
  }

  const pane = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'このセッションの節約' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '今日の節約（合計）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '今日の節約（確定）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '今日の節約（サブ）' })).toBeDefined()
})

test('a subagent’s cut alone is in the session’s figure', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await $.tool.call({ tool: 'Bash', tool_use_id: 'sub_1', command: 'bun test', agentId: 'ag1' } as never)
  await calls.clock.advance(4_000)

  const inSubagent = sum(parseLedger(calls.store.get('ledger:v1')), 'A1:subSavedTokens')
  expect(await savedIn(ui)).toBe(`約 ${Math.round(inSubagent / 1000)}k tok`)
  expect(await savedLabelIn(ui)).toBe('節約（延べ）')
})

for (const digest of ['observe', 'off'] as const) {
  test(`the band keeps quiet about savings where nothing was cut: the digest set to ${digest}`, { options: { digest } }, async ($, on) => {
    const calls = engine(on, { tmp: TMP })
    on('tool.call', () => bash(log()))
    await $.session.start(START)
    const ui = await $.ui.mount({ ...bandProps(), surface: 'terminal' })
    await callBash($, 'a')
    await calls.clock.advance(4_000)
    expect(await savedIn(ui)).toBeUndefined()
    // The band itself is there, with its other figures.
    expect(await ui.find({ type: 'Text', text: '今回' })).toBeDefined()
  })
}

const LIGHT = (agent: string) => ({ agent, description: '', source: 'plugin', provider: { plugin: 'tokenomics', tier: 'user' } }) as never

test('the light agents are not offered to the model until delegation is on: no unmeasured delegation, no borrowed permissions', async ($, on) => {
  engine(on)
  await $.session.start(START)

  for (const agent of ['tokenomics:scout', 'tokenomics:test-runner', 'tokenomics:log-digest']) expect((await $.agent.offer(LIGHT(agent))).isOffered).toBe(false)
  // Other agents are none of its business.
  expect((await $.agent.offer(LIGHT('Explore'))).isOffered).toBe(true)
})

test('with delegation on, the model hears of them', { options: { delegation: 'auto' } }, async ($, on) => {
  engine(on)
  await $.session.start(START)

  expect((await $.agent.offer(LIGHT('tokenomics:scout'))).isOffered).toBe(true)
  expect((await $.agent.offer(LIGHT('tokenomics:log-digest'))).isOffered).toBe(true)
})

test('a person held back from the savings never has them offered', { options: { delegation: 'auto', holdoutPercent: 100 } }, async ($, on) => {
  engine(on)
  await $.session.start(START)

  expect((await $.agent.offer(LIGHT('tokenomics:scout'))).isOffered).toBe(false)
})

// ── One-line suggestions (nudges = suggest) ─────────────────────────────────────────────────────────────

const SUGGEST = { options: { nudges: 'suggest' } } as const
const COLD = { ...SMALL, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 80_000 }
const reply = ($: Driver, id: string, usage = SMALL) =>
  $.turn.complete({ answer: 'the answer', durationMs: 1, isAborted: false, turnId: id, reason: 'answer', usage } as never) as Promise<{ text: string }>
const subscription = (percent: number) => ({ ...measure.context(percent), rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['context', 'rateLimits'] as ['context', 'rateLimits'] })

/** The band above the prompt, as the terminal draws it (the cat's card). */
const band = ($: Driver, over: Parameters<typeof bandProps>[0] = {}) => $.ui.mount({ ...bandProps(over), surface: 'terminal' })

test('suggest: a conversation that has grown heavy puts one line in the cat’s card, and the reply itself is as it was', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(55))
  await ask($, 'next please')
  expect(await nudgeIn(ui)).toBeUndefined()
  expect(await phraseIn(ui)).toBeDefined()

  const done = await reply($, 't1')
  expect(done.text).toBe('the answer')
  // It stands where the cat’s phrase stood, which is gone while it shows.
  expect(await nudgeIn(ui)).toBe('重くなってきました（毎回 約110k tok を読み直し）。区切りで /compact を。')
  expect(await phraseIn(ui)).toBeUndefined()
  expect(await ui.find({ type: 'Raster', key: 'cat' })).toBeDefined()
  // Nothing is typed into the prompt for the person to press Enter on.
  expect(calls.filled).toEqual([])
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C2:shown:suggest:notice')).toBe(1)
  expect(count(ledger, 'C2:would:suggest:notice')).toBe(0)
})

test('suggest, with the cat off: there is no card, so the suggestion is a row after the reply, in its long form', { options: { nudges: 'suggest', hud: false } }, async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(55))

  expect((await reply($, 't1')).text).toBe('会話が重くなってきました（返信のたびに約 110k tok を読み直します）。区切りのよいところで /compact を。')
})

test('suggest: the line in the card is for the moment after the reply: the next prompt, /clear and a compaction each take it down', SUGGEST, async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(55))
  await reply($, 't1')
  expect(await nudgeIn(ui)).toContain('重くなってきました')

  // A command is not a move to a new subject: the line stays.
  await $.prompt.submit({ text: '/status', wait: false, origin: { kind: 'composer' } } as never)
  expect(await nudgeIn(ui)).toContain('重くなってきました')
  await ask($, 'and then?')
  expect(await nudgeIn(ui)).toBeUndefined()
  expect(await phraseIn(ui)).toBeDefined()

  // The same moment again, three turns on: it is taken down by /clear ...
  for (const id of ['q2', 'q3']) await reply($, id)
  await $.session.measure(measure.context(5))
  await $.session.measure(measure.context(55))
  await reply($, 't4')
  expect(await nudgeIn(ui)).toContain('重くなってきました')
  await $.session.end({ reason: 'clear' } as never)
  expect(await nudgeIn(ui)).toBeUndefined()

  // ... and by a compaction the person asked for.
  for (const id of ['r1', 'r2', 'r3']) await reply($, id)
  await $.session.measure(measure.context(5))
  await $.session.measure(measure.context(55))
  await reply($, 't8')
  expect(await nudgeIn(ui)).toContain('重くなってきました')
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] } as never)
  expect(await nudgeIn(ui)).toBeUndefined()
})

test('suggest: while a turn runs the line waits, and it is back when the turn is over', SUGGEST, async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(55))
  await reply($, 't1')

  const working = await band($, { isWorking: true })
  expect(await nudgeIn(working)).toBeUndefined()
  expect(await phraseIn(working)).toBeDefined()
  await working.unmount()
  const idle = await band($)
  expect(await nudgeIn(idle)).toContain('重くなってきました')
})

test('suggest: a second suggestion within three turns is held back, and a reply with nothing to say has no line', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(55))
  await reply($, 't1')
  expect(await nudgeIn(ui)).toContain('重くなってきました')
  await $.session.measure(measure.context(100))
  const second = await reply($, 't2')
  // The strong one was held for the gap, so this reply is the answer alone.
  expect(second.text).toBe('the answer')
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C2:would:suggest:strong')).toBe(1)
  expect(count(ledger, 'S:signal:observe:held_gap')).toBe(1)
})

test('suggest: on an API key what would be spared must be worth a line: a small conversation on a cheap model is not', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)
  await runStep($, { model: 'claude-sonnet-5-5' })
  await $.session.measure(measure.context(20))
  await ask($, '別件ですが、請求書のPDF出力を作ってください')

  expect((await reply($, 't1', { ...SMALL, model: 'claude-sonnet-5-5' })).text).toBe('the answer')
  expect(await nudgeIn(ui)).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C1:would:suggest:keyword')).toBe(1)
  expect(count(ledger, 'S:signal:observe:held_stake')).toBe(1)
})

test('suggest: the same moment on a subscription is worth a line, since tokens are what it spends', SUGGEST, async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await band($)
  await runStep($, { model: 'claude-sonnet-5-5' })
  await $.session.measure(subscription(20))
  await ask($, '別件ですが、請求書のPDF出力を作ってください')

  await reply($, 't1', { ...SMALL, model: 'claude-sonnet-5-5' })
  expect(await nudgeIn(ui)).toContain('別件のようです')
})

test('suggest: a lapsed cache is spoken of only if the reply really did re-read the conversation, and says what it cost', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(40))
  await ask($, 'continue')
  await reply($, 't1')
  await calls.clock.advance(10 * 60_000)
  await ask($, 'continue')
  // The cache survived (a long cache lifetime, say): nothing to say.
  expect((await reply($, 't2')).text).toBe('the answer')
  expect(await nudgeIn(ui)).toBeUndefined()

  await calls.clock.advance(10 * 60_000)
  await ask($, 'continue')
  await reply($, 't3', COLD)
  const cold = await nudgeIn(ui)
  expect(cold).toContain('読み直しました（約 $0.41）')
  expect(cold).toContain('約81k tok')
})

test('suggest: a subagent’s turn and a turn that did not end in an answer get no line', SUGGEST, async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(55))

  const sub = await $.turn.complete({ answer: 'r', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId: 'ag1', usage: SMALL } as never)
  expect(sub.text).toBe('r')
  const stopped = await $.turn.complete({ answer: 'half', durationMs: 1, isAborted: true, turnId: 'y', reason: 'aborted', usage: SMALL } as never)
  expect(stopped.text).toBe('half')
  expect(await nudgeIn(ui)).toBeUndefined()
  await reply($, 't1')
  expect(await nudgeIn(ui)).toContain('重くなってきました')
})

test('suggest: followed within a few turns it is counted as taken up; left alone, as passed over', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(55))
  await reply($, 't1')
  await $.session.end({ reason: 'clear' } as never)
  expect(count(await ledgerOf($, calls), 'C2:accepted:suggest:self')).toBe(1)

  // Three quiet replies, then it grows heavy again: far enough from the last for another to be made.
  for (const id of ['f1', 'f2']) await reply($, id)
  await $.session.measure(measure.context(5))
  await $.session.measure(measure.context(55))
  await reply($, 't2')
  for (let i = 3; i <= 8; i += 1) await reply($, `t${i}`)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C2:shown:suggest:notice')).toBe(2)
  expect(count(ledger, 'C2:dismissed:suggest:ignored')).toBe(1)
})

test('suggest: a kind made twenty times to little effect is given up, and only noted from then on', SUGGEST, async ($, on) => {
  let stored: Ledger = emptyLedger
  const NOW = 1_000_000
  for (let i = 0; i < 20; i += 1) stored = append(stored, { kind: 'shown', measure: 'C2', mode: 'suggest', arm: 'treat', tag: 'notice' }, NOW + i, 's')
  for (let i = 0; i < 15; i += 1) stored = append(stored, { kind: 'dismissed', measure: 'C2', mode: 'suggest', arm: 'treat', tag: 'ignored' }, NOW + 30 + i, 's')
  stored = append(stored, { kind: 'accepted', measure: 'C2', mode: 'suggest', arm: 'treat', tag: 'self' }, NOW + 50, 's')
  expect(retiredNudges(stored, NOW + 100)).toEqual(['C2'])

  const calls = engine(on, { store: { 'ledger:v1': stored } })
  await $.session.start(START)
  await $.session.measure(measure.context(55))
  expect((await reply($, 't1')).text).toBe('the answer')
  expect(count(await ledgerOf($, calls), 'C2:would:observe:notice')).toBe(1)
})

test('a kind that is followed is not given up', async () => {
  const NOW = 1_000_000
  let stored: Ledger = emptyLedger
  for (let i = 0; i < 20; i += 1) stored = append(stored, { kind: 'shown', measure: 'C1', mode: 'suggest', arm: 'treat', tag: 'keyword' }, NOW + i, 's')
  for (let i = 0; i < 6; i += 1) stored = append(stored, { kind: 'accepted', measure: 'C1', mode: 'suggest', arm: 'treat', tag: 'self' }, NOW + 30 + i, 's')
  expect(retiredNudges(stored, NOW + 100)).toEqual([])
  expect(retiredNudges(emptyLedger, NOW)).toEqual([])
})

test('suggest, for a script: only noted', { options: { nudges: 'suggest' } }, async ($, on) => {
  const calls = engine(on)
  await $.session.start({ ...START, isInteractive: false } as never)
  await $.session.measure(measure.context(55))
  expect((await reply($, 't1')).text).toBe('the answer')
  expect(count(await ledgerOf($, calls), 'C2:would:observe:notice')).toBe(1)
})

test('suggest, for a person held back from the savings: only noted', { options: { nudges: 'suggest', holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(55))
  expect((await reply($, 't1')).text).toBe('the answer')
  expect(count(await ledgerOf($, calls), 'C2:would:observe:notice')).toBe(1)
})

test('by default nothing is said: the setting is observe', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(55))
  expect((await reply($, 't1')).text).toBe('the answer')
})

test('/tokenomics nudge-test shows the line once, wherever the setting stands, so it can be seen on screen', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)

  const ran = await $.command.run({ ...RUN, args: 'nudge-test' } as never)
  expect(ran.text).toContain('提案の表示テスト')
  expect(ran.text).toContain('帯のカード')
  expect((await reply($, 't1')).text).toBe('the answer')
  expect(await nudgeIn(ui)).toBe(DEMO_SHORT)
  await ask($, 'next')
  expect((await reply($, 't2')).text).toBe('the answer')
  expect(await nudgeIn(ui)).toBeUndefined()
  expect(count(await ledgerOf($, calls), 'S:signal:observe:nudge_test')).toBe(1)
})

test('/tokenomics nudge-test, with the cat off, shows the long line as a row after the reply', { options: { hud: false } }, async ($, on) => {
  engine(on)
  await $.session.start(START)

  const ran = await $.command.run({ ...RUN, args: 'nudge-test' } as never)
  expect(ran.text).toContain('一行')
  expect((await reply($, 't1')).text).toBe(DEMO_LINE)
  expect((await reply($, 't2')).text).toBe('the answer')
})

test('/tokenomics export hands over the ledger: counts and sums with the settings, and nothing of the work', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await ask($, '別件ですが、/repo/secret/plan.md の件をお願いします')
  await callBash($, 'toolu_secret', 'cat /repo/secret/keys.txt')

  const ran = await $.command.run({ ...RUN, args: 'export' } as never)
  // The output goes into the conversation and is read again on every later turn: it says where the record is, and does not hold it.
  const [head, settings, file, copied, ...rest] = (ran.text as string).split('\n')
  expect(head).toContain('件数と合計だけ')
  expect(settings).toContain('digest=auto')
  expect(file).toBe(`保存先（記録そのものには書かれません）: ${TMP}/claude-tokenomics/ledger-export.json`)
  expect(copied).toContain('クリップボードにコピーしました')
  expect(rest).toEqual([])
  expect(ran.text).not.toContain('"participant"')
  const json = calls.copied[0]!
  const parsed = JSON.parse(json!) as { v: number; participant: string; arm: string; version: string; options: Record<string, unknown>; days: { counts: Record<string, number> }[] }
  expect(parsed.v).toBe(1)
  expect(parsed.participant).toMatch(/^[0-9a-f]{8}$/)
  expect(parsed.arm).toBe('treat')
  expect(parsed.options.digest).toBe('auto')
  expect(parsed.days[0]!.counts['A1:fired:auto']).toBe(1)
  // The same text is in the file.
  expect(calls.writes.find(w => w.path.endsWith('ledger-export.json'))?.text).toBe(json)
  for (const private_ of ['/repo', 'secret', 'keys.txt', 'plan.md', '別件', 'toolu_secret', 'sess-1']) {
    expect(ran.text).not.toContain(private_)
    expect(json).not.toContain(private_)
  }
})

test('/tokenomics export without a private temp folder puts the record on the clipboard alone', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ran = await $.command.run({ ...RUN, args: 'export' } as never)
  expect(calls.copied[0]).toContain('"v":1')
  expect(ran.text).not.toContain('"v":1')
  expect(calls.writes.filter(w => w.path.endsWith('ledger-export.json'))).toEqual([])
})

test('/tokenomics export with neither a clipboard nor a place to save prints the record, with a word to /clear', async ($, on) => {
  const calls = engine(on)
  calls.isCopyBroken = true
  await $.session.start(START)
  const ran = await $.command.run({ ...RUN, args: 'export' } as never)
  expect(ran.text).toContain('"v":1')
  expect(ran.text).toContain('/clear')
})

test('/tokenomics reset-ledger empties this machine’s ledger', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  await callBash($, 'a')
  await calls.clock.advance(4_000)
  expect(count(parseLedger(calls.store.get('ledger:v1')), 'A1:fired:auto')).toBe(1)

  const ran = await $.command.run({ ...RUN, args: 'reset-ledger' } as never)
  expect(ran.text).toContain('空にしました')
  expect(calls.store.get('ledger:v1')).toBeUndefined()
  await calls.clock.advance(4_000)
  expect(count(parseLedger(calls.store.get('ledger:v1')), 'A1:fired:auto')).toBe(0)
})

test('a subagent type a person defined, or another plugin’s, is never named in the ledger or the export', { options: { delegation: 'auto' } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => ({ result: { type: 'text' }, text: 'started', isReadOnly: true, ref: 1 }) as never)
  on('agent.spawn', (_$, e) => ({ model: String(e.model ?? e.parentModel), agentId: 'ag1' }))
  await $.session.start(START)

  await spawnExplore($, 'acme-billing-reviewer')
  await spawnExplore($, 'acmecorp:payments-auditor')
  await subagentDone($, 'ag1')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'x', description: 'd', prompt: 'p', subagent_type: 'acme-billing-reviewer' } as never)
  const ledger = await ledgerOf($, calls)
  const exported = (await $.command.run({ ...RUN, args: 'export' } as never)) as { text: string }
  for (const name of ['acme', 'billing', 'payments', 'auditor']) {
    expect(JSON.stringify(calls.store.get('ledger:v1'))).not.toContain(name)
    expect(calls.copied.join('\n')).not.toContain(name)
    expect(exported.text).not.toContain(name)
  }
  expect(count(ledger, 'B1:signal:auto:custom_opus')).toBe(1)
  expect(count(ledger, 'B1:signal:auto:plugin_opus')).toBe(1)
})

test('suggest: the dialogs that say the same as a one-line suggestion are not opened, so nobody is asked twice', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(78))

  expect(dialogs(calls)).toBe(0)
  await reply($, 't1')
  expect(await nudgeIn(ui)).toContain('重く')
})

test('suggest: a kind that has been given up is back to the old dialog', SUGGEST, async ($, on) => {
  const NOW = 1_000_000
  let stored: Ledger = emptyLedger
  for (let i = 0; i < 20; i += 1) stored = append(stored, { kind: 'shown', measure: 'C2', mode: 'suggest', arm: 'treat', tag: 'notice' }, NOW + i, 's')
  for (let i = 0; i < 15; i += 1) stored = append(stored, { kind: 'dismissed', measure: 'C2', mode: 'suggest', arm: 'treat', tag: 'ignored' }, NOW + 30 + i, 's')
  const calls = engine(on, { store: { 'ledger:v1': stored } })
  await $.session.start(START)
  await $.session.measure(measure.context(78))
  // The kind is no longer made as a line, so the old dialog that says the same is what is shown, not silence.
  expect(dialogs(calls)).toBe(1)
})

// ── Did handing the work to a subagent make the main conversation read the same files again? ─────────────

const readFile = ($: Driver, path: string, agentId?: string) =>
  $.tool.call({ tool: 'Read', tool_use_id: `r-${path}-${agentId ?? 'main'}`, file_path: path, ...(agentId === undefined ? {} : { agentId }) } as never)

const subagentDone = ($: Driver, agentId: string) =>
  $.turn.complete({ answer: 'report', durationMs: 1, isAborted: false, turnId: `${agentId}-t`, reason: 'answer', agentId, usage: SMALL } as never)

const spawnExplore = ($: Driver, type = 'Explore') =>
  $.agent.spawn({ prompt: 'p', description: 'find the handler', subagentType: type, tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false } as never)

test('the main conversation reading what a subagent read, soon after it finished, is counted once per file; nothing is kept but the count', async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => ({ result: { type: 'text' }, text: 'lines', isReadOnly: true, ref: 1 }) as never)
  on('agent.spawn', (_$, e) => ({ model: String(e.model ?? e.parentModel), agentId: 'ag1' }))
  await $.session.start(START)

  await spawnExplore($)
  await readFile($, '/repo/src/a.ts', 'ag1')
  await readFile($, '/repo/src/b.ts', 'ag1')
  await subagentDone($, 'ag1')
  await readFile($, '/repo/src/a.ts')
  await readFile($, '/repo/src/a.ts')
  await readFile($, '/repo/src/other.ts')
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B1:signal:observe:readers_Explore')).toBe(1)
  expect(count(ledger, 'B1:outcome:observe:reread_Explore')).toBe(1)
  const written = JSON.stringify(calls.store.get('ledger:v1'))
  expect(written).not.toContain('/repo')
  expect(written).not.toContain('a.ts')
})

test('a subagent that read nothing is not counted, and a read long after it finished is not a re-read', async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => ({ result: { type: 'text' }, text: 'lines', isReadOnly: true, ref: 1 }) as never)
  await $.session.start(START)

  await subagentDone($, 'quiet')
  await readFile($, '/repo/src/a.ts', 'ag2')
  await subagentDone($, 'ag2')
  for (let i = 0; i < 6; i += 1) await reply($, `later-${i}`)
  await readFile($, '/repo/src/a.ts')
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B1:signal:observe:readers_custom')).toBe(1)
  expect(count(ledger, 'B1:outcome:observe:reread_custom')).toBe(0)
})

test('a spawn that repeats a recent one is noted as a re-delegation', { options: { delegation: 'auto' } }, async ($, on) => {
  const calls = engine(on)
  on('agent.spawn', (_$, e) => ({ model: String(e.model ?? e.parentModel), agentId: 'ag1' }))
  await $.session.start(START)
  const spawn = () =>
    $.agent.spawn({ prompt: 'p', description: 'find where the login handler is defined', subagentType: 'Explore', tool_use_id: 'a', parentModel: 'claude-opus-5-5', fork: false, background: false } as never)
  await spawn()
  await spawn()
  expect(count(await ledgerOf($, calls), 'B1:signal:auto:redelegated_Explore')).toBe(1)
})

test('/tokenomics handoff writes the note of what a fresh start would lose, and says how to carry it on', async ($, on) => {
  const calls = engine(on, {
    tmp: TMP,
    messages: [
      { role: 'user', text: 'Add a dark mode toggle', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/theme.ts' } }] },
      { role: 'assistant', text: 'Done.', toolUses: [] },
    ],
  })
  await $.session.start(START)

  const ran = await $.command.run({ ...RUN, args: 'handoff' } as never)
  const note = calls.writes.find(w => w.path.startsWith(`${DIR}/handoff-`))
  expect(note?.text).toContain('Add a dark mode toggle')
  expect(note?.text).toContain('/repo/theme.ts')
  expect(ran.text).toContain(note!.path)
  expect(ran.text).toContain('/clear のあと')
  // The model is not asked: it costs nothing.
  expect(calls.steps).toEqual([])
})

test('without a temp folder of the person’s own, no note is written: its contents would be readable by others', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  const ran = await $.command.run({ ...RUN, args: 'handoff' } as never)
  expect(ran.text).toContain('TMPDIR')
  expect(calls.writes.filter(w => w.path.includes('handoff-'))).toEqual([])
})

// ── Found in the independent review ─────────────────────────────────────────────────────────────────────

const ofMeasure = (ledger: ReturnType<typeof parseLedger>, measure: string): number =>
  ledger.days.reduce((n, d) => n + Object.entries(d.counts).reduce((t, [k, v]) => (k.startsWith(`${measure}:`) ? t + v : t), 0), 0)

test('what was not cut is not counted as spared: observe keeps its figures apart from the saved ones', { options: { digest: 'observe' } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', () => bash(log()))
  await $.session.start(START)
  // Not a whole test run or a log file, which the steering would note as well.
  await callBash($, 'a', 'cat build.out')

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:would:observe')).toBe(1)
  expect(sum(ledger, 'A1:savedTokens')).toBe(0)
  expect(sum(ledger, 'A1:wouldTokens')).toBeGreaterThan(10_000)
  expect(savingsToday(ledger, ledger.recent[0]!.t)).toEqual({ digests: 0, tokens: 0, milliUsd: 0, wouldFire: 1, recovered: 0, forks: 0, keptTokens: 0, keptMilliUsd: 0, forkReaders: 0, forkRereads: 0, forkCostMilliUsd: 0, forkLosses: 0, subCuts: 0, subTokens: 0, flowReqs: 0, flowTokens: 0, flowKeptTokens: 0, flowMicroUsd: 0 })
})

test('a suggestion replaced by the next at the shortest gap, with nothing done in between, is counted as passed over', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const ui = await band($)
  await $.session.measure(measure.context(55))
  await reply($, 't1')
  expect(await nudgeIn(ui)).toContain('重くなってきました')
  for (const id of ['q2', 'q3']) await reply($, id)
  await $.session.measure(measure.context(5))
  await $.session.measure(measure.context(55))
  // Three turns after the first: the gap allows it, and the first was never answered.
  await reply($, 't4')
  expect(await nudgeIn(ui)).toContain('重くなってきました')
  for (const id of ['q5', 'q6', 'q7', 'q8']) await reply($, id)

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'C2:shown:suggest:notice')).toBe(2)
  expect(count(ledger, 'C2:dismissed:suggest:ignored')).toBe(2)
})

test('only a compaction the person asked for is their answer to a suggestion: not a precompute, not the engine’s own', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(55))
  await reply($, 't1')

  const messages = [{ role: 'user', text: 'hello', toolUses: [] }]
  for (const trigger of ['precompute', 'auto']) await $.session.compact({ trigger, messages } as never)
  await $.session.end({ reason: 'exit' } as never)
  expect(count(parseLedger(calls.store.get('ledger:v1')), 'C2:accepted:suggest:self')).toBe(0)
  await $.session.compact({ trigger: 'manual', messages } as never)
  expect(count(await ledgerOf($, calls), 'C2:accepted:suggest:self')).toBe(1)
})

test('after /clear the old window’s size and the time away are forgotten: no line on a lapsed cache for a conversation that is gone', SUGGEST, async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(40))
  await ask($, 'continue')
  await reply($, 't1')
  await calls.clock.advance(10 * 60_000)
  await $.session.end({ reason: 'clear' } as never)
  await ask($, 'a new task')
  // The first reply of a new window writes its prompt to the cache: that is not the old conversation coming back cold.
  expect((await reply($, 't2', COLD)).text).toBe('the answer')
  expect(ofMeasure(await ledgerOf($, calls), 'C3')).toBe(0)
})

test('the model going back for what was cut is counted once per saved output, and not for the work notes or after an edit', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? bash(log()) : ({ result: { type: 'text' }, text: 'line', isReadOnly: true, ref: 1 }) as never))
  await $.session.start(START)

  await callBash($, 'a', 'bun test')
  // The pointer tells the model to read by offset and limit: three pieces of one file are one going back.
  for (const id of ['r1', 'r2', 'r3']) await $.tool.call({ tool: 'Read', tool_use_id: id, file_path: `${DIR}/out-a.log`, offset: 1 } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r4', file_path: `${DIR}/handoff-1.md` } as never)
  // Edit, then test again: the loop of the work, not a second look at what was cut.
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/repo/a.ts' } as never)
  await callBash($, 'b', 'bun test')

  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:outcome:auto:readback')).toBe(1)
  expect(count(ledger, 'A1:outcome:auto:rerun')).toBe(0)
})

test('a failed command’s big output cannot be cut (the engine refuses an errored answer of another shape): it is left as it was, and counted', AUTO, async ($, on) => {
  const calls = engine(on, { tmp: TMP })
  const text = `Exit code 1\n${log()}`
  on('tool.call', () => ({ result: `Error: ${text}`, text, isError: true, isReadOnly: true, ref: 1 }) as never)
  await $.session.start(START)

  const ran = await callBash($, 'toolu_fail', 'bun test')
  expect(ran.text).toBe(text)
  expect(calls.writes.filter(w => w.path.includes('claude-tokenomics'))).toEqual([])
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'A1:signal:auto:big_error')).toBe(1)
  expect(count(ledger, 'A1:fired:auto')).toBe(0)
  expect(count(ledger, 'A1:error:observe')).toBe(0)
})

// ── /clear: the note, and the one line for the conversation that follows ─────────────────────────────────

const WORK = [
  { role: 'user' as const, text: 'Make the savings visible', toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/repo/band.tsx' } }] },
  { role: 'assistant' as const, text: 'Next: check the band at 80 columns.', toolUses: [] },
]
const GIT = '## token-usage-advisor...origin/token-usage-advisor [ahead 1]\n M mods/tokenomics/hooks/register.tsx\n?? notes.md\n'
const CLEAR = { reason: 'clear', sessionId: 'sess-1' } as never
const notes = (calls: Calls) => calls.writes.filter(w => w.path.startsWith(`${DIR}/handoff-`))
const afterClear = ($: Driver) => $.classic.SessionStart({ source: 'clear' } as never)
const ledgerNow = (calls: Calls) => parseLedger(calls.store.get('ledger:v1'))

test('/clear writes a note of the conversation, and the next one is told in a line where it is, with the git state added', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK, git: GIT })
  await $.session.start(START)

  await $.session.end(CLEAR)
  expect(notes(calls)).toHaveLength(1)
  const path = notes(calls)[0]!.path
  expect(notes(calls)[0]!.text).toContain('# Work notes saved before /clear')
  expect(notes(calls)[0]!.text).toContain('Make the savings visible')
  expect(notes(calls)[0]!.text).toContain('Next: check the band at 80 columns.')
  // The git state is not asked for in the time `session.end` leaves.
  expect(calls.processes).toEqual([])

  const started = await afterClear($)
  expect(started.additionalContext).toHaveLength(1)
  expect(started.additionalContext![0]).toContain(path)
  expect(started.additionalContext![0]).toContain('only if the person asks you to carry on')
  expect(calls.processes).toEqual([['git', 'status', '--short', '--branch']])
  const final = notes(calls).at(-1)!
  expect(final.path).toBe(path)
  expect(final.text).toContain('branch: token-usage-advisor...origin/token-usage-advisor [ahead 1]')
  expect(final.text).toContain(' M mods/tokenomics/hooks/register.tsx')
  // The model is not asked: it costs nothing.
  expect(calls.steps).toEqual([])

  // The ledger holds what happened, for the person's own look.
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'S:signal:observe:clear_note_written')).toBe(1)
  expect(count(ledger, 'S:signal:observe:clear_pointer_given')).toBe(1)
})

test('the ledger is written out at a /clear, with the note’s own signal, before the next conversation has begun', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(count(ledgerNow(calls), 'S:signal:observe:clear_note_written')).toBe(1)
  expect(sum(ledgerNow(calls), 'S:chars')).toBeGreaterThan(100)
})

test('the line is given once: a second start after a /clear, and a start that is not a /clear, get none', async ($, on) => {
  engine(on, { tmp: TMP, messages: WORK })
  await $.session.start(START)

  await $.session.end(CLEAR)
  expect((await afterClear($)).additionalContext).toHaveLength(1)
  expect((await afterClear($)).additionalContext ?? []).toEqual([])
  await $.session.end(CLEAR)
  for (const source of ['startup', 'resume', 'compact', 'fork']) expect((await $.classic.SessionStart({ source } as never)).additionalContext ?? []).toEqual([])
})

test('a /clear of a conversation with nothing in it, or that cannot be read, leaves no note and no line, and says why in the ledger', async ($, on) => {
  const empty = engine(on, { tmp: TMP, messages: [] })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(notes(empty)).toEqual([])
  expect((await afterClear($)).additionalContext ?? []).toEqual([])
  expect(count(ledgerNow(empty), 'S:signal:observe:clear_note_skipped_unavailable')).toBe(1)
  expect(count(await ledgerOf($, empty), 'S:signal:observe:clear_start_without_note')).toBe(1)
})

test('a conversation with a request that was never answered is not worth a note', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(notes(calls)).toEqual([])
  expect(count(ledgerNow(calls), 'S:signal:observe:clear_note_skipped_empty')).toBe(1)
})

test('without a temp folder of the person’s own, a /clear leaves no note and no line', async ($, on) => {
  const calls = engine(on, { messages: WORK })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(notes(calls)).toEqual([])
  expect((await afterClear($)).additionalContext ?? []).toEqual([])
  expect(count(ledgerNow(calls), 'S:signal:observe:clear_note_skipped_tmp')).toBe(1)
})

test('set to off, a /clear writes nothing and says nothing', { options: { handoffNote: false } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(notes(calls)).toEqual([])
  expect((await afterClear($)).additionalContext ?? []).toEqual([])
  expect(calls.processes).toEqual([])
})

test('a person held back from the savings gets no note and no line, though the ledger says it was skipped', { options: { holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(notes(calls)).toEqual([])
  expect((await afterClear($)).additionalContext ?? []).toEqual([])
  expect(count(ledgerNow(calls), 'S:signal:control:clear_note_skipped_control') + count(ledgerNow(calls), 'S:signal:observe:clear_note_skipped_control')).toBe(1)
})

test('a note that cannot be written is a quiet failure: no line, and the end of the session goes on', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK, isWriteBroken: true })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect((await afterClear($)).additionalContext ?? []).toEqual([])
  expect(count(ledgerNow(calls), 'S:signal:observe:clear_note_failed')).toBe(1)
})

test('any other end of a session writes no note', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK })
  await $.session.start(START)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1' } as never)
  expect(notes(calls)).toEqual([])
})

test('git that cannot run leaves the note as it was written, and the line is still given', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK })
  await $.session.start(START)
  await $.session.end(CLEAR)
  const started = await afterClear($)
  expect(started.additionalContext).toHaveLength(1)
  expect(notes(calls)).toHaveLength(1)
  expect(notes(calls)[0]!.text).not.toContain('Git state')
})

test('the model may read the note after a /clear without being asked, whatever the digest does; other files still ask', { options: { digest: 'off' } }, async ($, on) => {
  engine(on, { tmp: TMP, messages: WORK })
  on('tool.check', () => ({ decision: 'ask', reason: 'because' }))
  await $.session.start(START)
  const check = (file_path: string) => $.tool.check({ tool: 'Read', input: { file_path } } as never)
  expect((await check(`${DIR}/handoff-1000000.md`)).decision).toBe('allow')
  expect((await check(`${DIR}/out-a.log`)).decision).toBe('ask')
  expect((await check('/etc/hosts')).decision).toBe('ask')
  expect((await check(`${DIR}/../other/handoff-1.md`)).decision).toBe('ask')
})

test('a long task after an auto-compaction: the only user turn is the carried-over summary, and a /clear still writes a note holding its head', async ($, on) => {
  const carried = {
    role: 'user' as const,
    text: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request and Intent:\n   - Make the savings visible to users\n',
    toolUses: [],
  }
  const calls = engine(on, {
    tmp: TMP,
    messages: [
      carried,
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/repo/band.tsx' } }] },
      { role: 'assistant', text: 'Next: the report.', toolUses: [] },
    ],
  })
  await $.session.start(START)
  await $.session.end(CLEAR)
  expect(notes(calls)).toHaveLength(1)
  expect(notes(calls)[0]!.text).toContain('Primary Request and Intent')
  expect(notes(calls)[0]!.text).toContain('/repo/band.tsx')
  expect((await afterClear($)).additionalContext).toHaveLength(1)
})

test('the git state is asked for within the time the start has, and a git that fails never costs the line', async ($, on) => {
  const calls = engine(on, { tmp: TMP, messages: WORK, isGitBroken: true })
  await $.session.start(START)
  await $.session.end(CLEAR)
  const started = await afterClear($)
  expect(calls.processTimeouts).toEqual([2_000])
  expect(started.additionalContext).toHaveLength(1)
  expect(notes(calls)).toHaveLength(1)
})

const TOPIC = { options: { nudges: 'suggest', hud: false } } as const

test('suggest, a topic change: where /clear writes its own note the line says so, and does not ask for one first', TOPIC, async ($, on) => {
  engine(on, { tmp: TMP })
  await $.session.start(START)
  await runStep($, { model: 'claude-sonnet-5-5' })
  await $.session.measure(subscription(20))
  await ask($, '別件ですが、請求書のPDF出力を作ってください')

  const text = (await reply($, 't1', { ...SMALL, model: 'claude-sonnet-5-5' })).text
  expect(text).toContain('要点は /clear のときに自動でメモに残ります')
  expect(text).not.toContain('/tokenomics handoff')
})

test('suggest, a topic change: with no note to be written the line still asks for one first', { options: { nudges: 'suggest', hud: false, handoffNote: false } }, async ($, on) => {
  engine(on, { tmp: TMP })
  await $.session.start(START)
  await runStep($, { model: 'claude-sonnet-5-5' })
  await $.session.measure(subscription(20))
  await ask($, '別件ですが、請求書のPDF出力を作ってください')

  expect((await reply($, 't1', { ...SMALL, model: 'claude-sonnet-5-5' })).text).toContain('/tokenomics handoff')
})

