import { type Engine, describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/lib/core/ledger'
import { GAP_TURNS, SEARCH_AT, callKind, callKey, freshSteer, lightUse, steerAnswered, steerNote, steerStep, steerTurn } from '../hooks/lib/core/steer'

import { type Calls, engine } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const bashCall = (command: string) => ({ command })

describe('what counts as a search or a whole test run', () => {
  test('searches through the shell, alone or after a cd, and the tools that search', () => {
    for (const c of ['grep -rn foo src', 'rg foo', 'cd app && rg -n "foo" .', 'find . -name "*.ts"', 'git grep foo', 'FOO=1 grep x y', 'ag foo', 'fd config']) {
      expect(callKind('Bash', bashCall(c))).toBe('search')
    }
    expect(callKind('Grep', { pattern: 'x' })).toBe('search')
    expect(callKind('Glob', { pattern: '**/*.ts' })).toBe('search')
  })

  test('not searches: a search at the end of a pipe, a find that changes things, reading, listing', () => {
    for (const c of ['ls src | grep foo', 'cat a.ts | grep x', 'find . -name "*.o" -delete', 'find . -exec rm {} ;', 'cat src/a.ts', 'ls -la', 'git status', 'echo grep']) {
      expect(callKind('Bash', bashCall(c))).toBeNull()
    }
    expect(callKind('Read', { file_path: '/a' })).toBeNull()
    expect(callKind('Bash', {})).toBeNull()
  })

  test('whole-suite test runs, with bare flags and a cd in front', () => {
    for (const c of [
      'npm test',
      'npm run test',
      'pnpm test',
      'yarn test',
      'bun test',
      'bun test --coverage',
      'npm test -- --coverage',
      'cd app && npm test',
      'npx vitest',
      'pytest',
      'pytest -x -q',
      'python -m pytest',
      'go test ./...',
      'cargo test',
      'swift test',
      'dotnet test',
      './gradlew test',
      'mvn -q test',
      'make test',
      'bun test 2>&1',
      'CI=1 npm test',
    ]) {
      expect(callKind('Bash', bashCall(c))).toBe('test')
    }
  })

  test('not a whole run: a file, a name, a pattern, a path, a pipe, a chain, a redirect', () => {
    for (const c of [
      'bun test tests/steer.test.ts',
      'bun test -t "a name"',
      'npm test -- foo',
      'pytest tests/test_a.py',
      'pytest -k login',
      'go test ./pkg/auth',
      'cargo test parse',
      'bun test | tail -20',
      'npm test > out.log',
      'npm run build && npm test',
      'npm run lint',
      'git test',
    ]) {
      expect(callKind('Bash', bashCall(c))).toBeNull()
    }
  })

  test('the same call has the same key, whatever the spacing', () => {
    expect(callKey('Bash', bashCall('grep  -rn   foo src'))).toBe(callKey('Bash', bashCall(' grep -rn foo src ')))
    expect(callKey('Bash', bashCall('grep foo'))).not.toBe(callKey('Bash', bashCall('grep bar')))
  })

  test('a skill or an agent of the plugin, by either name', () => {
    expect(lightUse('Skill', { skill: 'tokenomics:scout' })).toBe('scout')
    expect(lightUse('Skill', { skill: 'test-summary' })).toBe('test-summary')
    expect(lightUse('Agent', { subagent_type: 'tokenomics:test-runner' })).toBe('test-runner')
    expect(lightUse('Skill', { skill: 'commit' })).toBeNull()
    expect(lightUse('Skill', { skill: 'other:scout' })).toBeNull()
    expect(lightUse('Agent', { subagent_type: 'scout' })).toBeNull()
    expect(lightUse('Bash', { command: 'ls' })).toBeNull()
  })
})

describe('when a call is turned back', () => {
  const grep = (n: number) => bashCall(`grep -rn needle${n} src`)
  const run = (s = freshSteer(), n = SEARCH_AT, turn = 1) => {
    let state = s
    let last = steerStep(state, 'Bash', grep(0), turn)
    for (let i = 0; i < n; i += 1) {
      last = steerStep(state, 'Bash', grep(i), turn)
      state = last.next
    }
    return last
  }

  test('the first searches of a turn run, the third is turned back', () => {
    let s = freshSteer()
    for (let i = 1; i < SEARCH_AT; i += 1) {
      const v = steerStep(s, 'Bash', grep(i), 1)
      expect(v.say).toBe('pass')
      s = v.next
    }
    const third = steerStep(s, 'Bash', grep(SEARCH_AT), 1)
    expect(third).toMatchObject({ say: 'refuse', kind: 'search', searches: SEARCH_AT })
  })

  test('a turn starts the count over', () => {
    let s = freshSteer()
    for (let i = 1; i < SEARCH_AT; i += 1) s = steerStep(s, 'Bash', grep(i), 1).next
    s = steerTurn(s)
    expect(steerStep(s, 'Bash', grep(9), 2).say).toBe('pass')
  })

  test('an edit earlier in the turn means the model is working on what it found: not turned back', () => {
    let s = steerStep(freshSteer(), 'Edit', { file_path: '/a' }, 1).next
    for (let i = 1; i <= SEARCH_AT + 2; i += 1) {
      const v = steerStep(s, 'Bash', grep(i), 1)
      expect(v.say).toBe('pass')
      s = v.next
    }
  })

  test('reading is never turned back, however much of it there is', () => {
    let s = freshSteer()
    for (let i = 0; i < 12; i += 1) {
      const v = steerStep(s, 'Read', { file_path: `/f${i}` }, 1)
      expect(v.say).toBe('pass')
      s = v.next
    }
  })

  test('a test run is turned back the first time, and a kind not again within the gap', () => {
    const v = steerStep(freshSteer(), 'Bash', bashCall('bun test'), 1)
    expect(v).toMatchObject({ say: 'refuse', kind: 'test' })
    const soon = steerStep(v.next, 'Bash', bashCall('npm test'), 1 + GAP_TURNS - 1)
    expect(soon.say).toBe('pass')
    const later = steerStep(v.next, 'Bash', bashCall('npm test'), 1 + GAP_TURNS)
    expect(later.say).toBe('refuse')
  })

  test('making the same call again runs it, and that kind is then left alone for the session', () => {
    const first = steerStep(freshSteer(), 'Bash', bashCall('bun test'), 1)
    const again = steerStep(first.next, 'Bash', bashCall('bun  test'), 1)
    expect(again).toMatchObject({ say: 'insist', kind: 'test' })
    const much = steerStep(again.next, 'Bash', bashCall('bun test'), 1 + GAP_TURNS * 5)
    expect(much.say).toBe('pass')
    // The other kind is not given up.
    const s = run()
    expect(s.say).toBe('refuse')
  })

  test('when only watching, a repeat is no insistence and the kind is not given up', () => {
    const first = steerStep(freshSteer(), 'Bash', bashCall('bun test'), 1, true)
    expect(first.say).toBe('refuse')
    const again = steerStep(first.next, 'Bash', bashCall('bun test'), 1, true)
    expect(again.say).toBe('pass')
    expect(again.next.insisted).toEqual([])
  })

  test('a repeat long after is a new call, not the same one insisted on', () => {
    const first = steerStep(freshSteer(), 'Bash', bashCall('bun test'), 1)
    const late = steerStep(first.next, 'Bash', bashCall('bun test'), 1 + GAP_TURNS)
    expect(late.say).toBe('refuse')
  })

  test('a skill used soon after is the answer, once; later it is not', () => {
    const first = steerStep(freshSteer(), 'Bash', bashCall('bun test'), 5)
    expect(steerAnswered(first.next, 6)).toMatchObject({ kind: 'test' })
    expect(steerAnswered(steerAnswered(first.next, 6).next, 6).kind).toBeNull()
    expect(steerAnswered(first.next, 5 + 9).kind).toBeNull()
  })

  test('the notes name the skill and say how to go on', () => {
    expect(steerNote('search', 3)).toContain('tokenomics:scout')
    expect(steerNote('search', 3)).toContain('same call again')
    expect(steerNote('test', 0)).toContain('tokenomics:test-summary')
    expect(steerNote('test', 0)).toContain('same call again')
  })
})

type Driver = Engine
type Out = { deny?: string; text?: string }

const grepLine = (n: number) => `grep -rn needle${n} src`

const callBash = ($: Driver, id: string, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', tool_use_id: id, command, ...(agentId === undefined ? {} : { agentId }) } as never) as unknown as Promise<Out>

const reply = () => ({ result: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: 'ok', isReadOnly: true, ref: 1 }) as never

const ledgerOf = async ($: Driver, calls: Calls) => {
  await $.session.end({ reason: 'exit' } as never)
  return parseLedger(calls.store.get('ledger:v1'))
}

const count = (ledger: ReturnType<typeof parseLedger>, key: string): number => ledger.days.reduce((n, d) => n + (d.counts[key] ?? 0), 0)

const turn = ($: Driver) => $.turn.start({ text: 'go', turnId: 't1' } as never)

const AUTO = { options: { digest: 'off', steer: 'auto' } } as const

test('the third search of a turn is turned back with a note that names the skill, and is not run', AUTO, async ($, on) => {
  const calls = engine(on)
  let ran = 0
  on('tool.call', () => {
    ran += 1
    return reply()
  })
  await $.session.start(START)
  await turn($)

  expect((await callBash($, 'a1', grepLine(1))).deny).toBeUndefined()
  expect((await callBash($, 'a2', grepLine(2))).deny).toBeUndefined()
  const third = await callBash($, 'a3', grepLine(3))
  expect(third.deny).toContain('tokenomics:scout')
  expect(ran).toBe(2)
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:fired:auto:search')).toBe(1)
})

test('the same call made again runs, is counted as insisted on, and that kind is not turned back again', AUTO, async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  const refused = await callBash($, 'b1', 'bun test')
  expect(refused.deny).toContain('tokenomics:test-summary')
  const again = await callBash($, 'b2', 'bun test')
  expect(again.deny).toBeUndefined()
  expect(again.text).toBe('ok')
  for (let i = 0; i < 6; i += 1) {
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await turn($)
  }
  expect((await callBash($, 'b3', 'npm test')).deny).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:fired:auto:test')).toBe(1)
  expect(count(ledger, 'B6:outcome:auto:insisted_test')).toBe(1)
})

test('a skill of the plugin used after a call was turned back is the answer to it', AUTO, async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  expect((await callBash($, 'c1', 'bun test')).deny).toBeDefined()
  const used = (await $.tool.call({ tool: 'Skill', tool_use_id: 'c2', skill: 'tokenomics:test-summary' } as never)) as unknown as Out
  expect(used.deny).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:signal:auto:used_test-summary')).toBe(1)
  expect(count(ledger, 'B6:outcome:auto:adopted_test')).toBe(1)
})

test('a skill the engine turns away is not counted as used, and answers nothing; one that started is', AUTO, async ($, on) => {
  const calls = engine(on)
  let skill: 'error' | 'deny' | 'ok' = 'error'
  on('tool.call', (_$, e) => {
    if (e.tool !== 'Skill') return reply()
    if (skill === 'deny') return { deny: 'no' } as never
    if (skill === 'error') return { isError: true, result: 'disable-model-invocation', text: 'disable-model-invocation' } as never
    return reply()
  })
  await $.session.start(START)
  await turn($)

  expect((await callBash($, 'g1', 'bun test')).deny).toBeDefined()
  const skillCall = (id: string) => $.tool.call({ tool: 'Skill', tool_use_id: id, skill: 'tokenomics:test-summary' } as never) as unknown as Promise<Out>
  await skillCall('g2')
  skill = 'deny'
  await skillCall('g3')
  skill = 'ok'
  await skillCall('g4')
  const ledger = await ledgerOf($, calls)
  // Of the three attempts only the last one launched; and the turned-back test run is answered by that one, not by the first.
  expect(count(ledger, 'B6:signal:auto:used_test-summary')).toBe(1)
  expect(count(ledger, 'B6:outcome:auto:adopted_test')).toBe(1)
})

test('a subagent is never turned back: the agents the skills fork search and run tests as they must', AUTO, async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  for (let i = 1; i <= 8; i += 1) expect((await callBash($, `d${i}`, grepLine(i), 'agent-1')).deny).toBeUndefined()
  expect((await callBash($, 'd9', 'bun test', 'agent-1')).deny).toBeUndefined()
  // And what a subagent did is not counted against the main conversation.
  expect((await callBash($, 'd10', grepLine(10))).deny).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:fired:auto:search')).toBe(0)
})

test('a test run narrowed to a file, a piped one and plain reading are not turned back', AUTO, async ($, on) => {
  engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  expect((await callBash($, 'e1', 'bun test tests/a.test.ts')).deny).toBeUndefined()
  expect((await callBash($, 'e2', 'bun test | tail -20')).deny).toBeUndefined()
  for (let i = 0; i < 6; i += 1) {
    const read = (await $.tool.call({ tool: 'Read', tool_use_id: `r${i}`, file_path: `/f${i}` } as never)) as unknown as Out
    expect(read.deny).toBeUndefined()
  }
})

test('an edit in the turn, searches after it run', AUTO, async ($, on) => {
  engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  await $.tool.call({ tool: 'Edit', tool_use_id: 'f0', file_path: '/a', old_string: 'x', new_string: 'y' } as never)
  for (let i = 1; i <= 5; i += 1) expect((await callBash($, `f${i}`, grepLine(i))).deny).toBeUndefined()
})

test('by default it only watches: nothing is turned back, and the ledger says what would have been', async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  for (let i = 1; i <= 4; i += 1) expect((await callBash($, `g${i}`, grepLine(i))).deny).toBeUndefined()
  expect((await callBash($, 'g5', 'bun test')).deny).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:would:observe:search')).toBe(1)
  expect(count(ledger, 'B6:would:observe:test')).toBe(1)
  expect(count(ledger, 'B6:fired:auto:search')).toBe(0)
})

test('off does nothing, not even a note', { options: { digest: 'off', steer: 'off' } }, async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  for (let i = 1; i <= 4; i += 1) expect((await callBash($, `h${i}`, grepLine(i))).deny).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:would:off:search')).toBe(0)
})

test('a person held back from the savings is never turned back', { options: { digest: 'off', steer: 'auto', holdoutPercent: 100 } }, async ($, on) => {
  const calls = engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  for (let i = 1; i <= 4; i += 1) expect((await callBash($, `i${i}`, grepLine(i))).deny).toBeUndefined()
  expect((await callBash($, 'i5', 'bun test')).deny).toBeUndefined()
  const ledger = await ledgerOf($, calls)
  expect(count(ledger, 'B6:fired:observe:search')).toBe(0)
  expect(count(ledger, 'B6:would:observe:search')).toBe(1)
})

test('a new turn starts the count of searches over', AUTO, async ($, on) => {
  engine(on)
  on('tool.call', () => reply())
  await $.session.start(START)
  await turn($)

  await callBash($, 'j1', grepLine(1))
  await callBash($, 'j2', grepLine(2))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await turn($)
  expect((await callBash($, 'j3', grepLine(3))).deny).toBeUndefined()
  expect((await callBash($, 'j4', grepLine(4))).deny).toBeUndefined()
})
