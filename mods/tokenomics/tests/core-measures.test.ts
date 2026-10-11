import { describe, expect, test } from 'claude-code/testing'

import { DIGEST, digestOutput, digestPath, isDigestFile, isInsideDir, normalizeCommand } from '../hooks/lib/core/digest'
import { ALLOWED_TYPES, REDELEGATION_TURNS, decideSpawn, lighterTarget, similarity, typeTag } from '../hooks/lib/core/downgrade'
import { ANSWER_TURNS, CLASSIFY, clearStakeUsd, coldReturn, pathsIn, risen, shouldClassify, topicShift } from '../hooks/lib/core/moments'
import { type Candidate, CANDIDATE_TURNS, DEMO_LINE, DEMO_SHORT, MIN_GAP_TURNS, MIN_STAKE_MILLI, chooseNudge, nudgeLine, nudgeShort } from '../hooks/lib/core/nudges'
import { cellWidth, wrappedRows } from '../hooks/lib/format'
import { cacheShare, contextBucket, idleBucket, wasCold } from '../hooks/lib/core/usage'

const PATH = '/var/T/claude-tokenomics/sess-1/out-toolu_01.log'

const lines = (n: number, make: (i: number) => string = i => `line ${i}`) => Array.from({ length: n }, (_, i) => make(i)).join('\n')

describe('digest', () => {
  test('leaves a small output alone, and the size it starts at can be raised', () => {
    expect(digestOutput('ok', PATH)).toBeNull()
    expect(digestOutput(lines(100), PATH)).toBeNull()
    const text = lines(2000, i => `PASS case ${i} ${'x'.repeat(10)}`)
    expect(digestOutput(text, PATH)).not.toBeNull()
    expect(digestOutput(text, PATH, 1_000_000)).toBeNull()
  })

  test('keeps the start, the lines that name a failure with a little around them, and the end', () => {
    const text = lines(2000, i => (i === 1000 ? 'FAIL src/auth.test.ts > login rejects a bad password' : `PASS case ${i} ${'x'.repeat(10)}`))
    const cut = digestOutput(text, PATH)!
    expect(cut.text).toContain('PASS case 0 ')
    expect(cut.text).toContain('FAIL src/auth.test.ts > login rejects a bad password')
    expect(cut.text).toContain('PASS case 999 ')
    expect(cut.text).toContain('PASS case 1001 ')
    expect(cut.text).toContain('PASS case 1999 ')
    expect(cut.text).toContain('lines omitted')
    expect(cut.text).not.toContain('PASS case 500 ')
    expect(cut.text.length).toBeLessThan(text.length / 5)
    expect(cut.savedChars).toBe(text.length - cut.text.length)
  })

  test('says where the full text is and how to read it, first of all', () => {
    const cut = digestOutput(lines(1500, i => `line ${i} ${'z'.repeat(20)}`), PATH)!
    const [first] = cut.text.split('\n')
    expect(first).toContain(PATH)
    expect(first).toMatch(/kept \d+ of 1500 lines/)
    expect(first).toContain('Read tool')
  })

  test('the lines that sum a test run up are kept wherever they are', () => {
    const text = lines(3000, i => (i === 1500 ? 'Tests:  2 failed, 1998 passed, 2000 total' : i === 1700 ? 'BUILD FAILURE' : `ok ${i} ${'y'.repeat(12)}`))
    const cut = digestOutput(text, PATH)!
    expect(cut.text).toContain('Tests:  2 failed, 1998 passed, 2000 total')
    expect(cut.text).toContain('BUILD FAILURE')
    expect(cut.text).not.toContain('ok 800 ')
  })

  test('keeps head, tail and a bounded number of failure lines when everything looks like a failure', () => {
    const cut = digestOutput(lines(3000, i => `error: step ${i} failed ${'y'.repeat(8)}`), PATH)!
    expect(cut.text.split('\n').length).toBeLessThan(DIGEST.head + DIGEST.tail + DIGEST.matched + DIGEST.summary + 20)
    expect(cut.text).toContain('error: step 0 ')
    expect(cut.text).toContain('error: step 2999 ')
  })

  test('cuts a few very long lines at both ends', () => {
    const cut = digestOutput(`{"a":"${'q'.repeat(50_000)}"}`, PATH)!
    expect(cut.text).toContain('characters omitted')
    expect(cut.text.length).toBeLessThan(DIGEST.headChars + DIGEST.tailChars + 600)
    expect(cut.text).toContain('{"a":"qqq')
    expect(cut.text).toContain(PATH)
  })

  test('an output that cannot be made clearly shorter is left as it was: a digest longer than the original is no digest', () => {
    // Every line looks like a failure and the whole run is a hundred lines: all of them would be kept, with a pointer on top.
    const text = lines(100, i => `error: case ${i} failed ${'y'.repeat(80)}`)
    expect(text.length).toBeGreaterThan(DIGEST.overChars)
    expect(digestOutput(text, PATH)).toBeNull()
  })

  test('tells a saved command output from the work notes kept beside it', () => {
    expect(isDigestFile('/var/T/claude-tokenomics/sess-1/out-toolu_01.log')).toBe(true)
    expect(isDigestFile('/var/T/claude-tokenomics/sess-1/handoff-1.md')).toBe(false)
    expect(isDigestFile('/var/T/claude-tokenomics/sess-1/out-x.log.bak')).toBe(false)
  })

  test('only a plainly spelled path under the saving folder counts as inside it', () => {
    const dir = '/var/T/claude-tokenomics/sess-1'
    expect(isInsideDir(dir, `${dir}/out-a.log`)).toBe(true)
    expect(isInsideDir(`${dir}/`, `${dir}/out-a.log`)).toBe(true)
    expect(isInsideDir(dir, `${dir}//out-a.log`)).toBe(true)
    expect(isInsideDir(dir, `${dir}/../sess-2/out-a.log`)).toBe(false)
    expect(isInsideDir(dir, `${dir}/./out-a.log`)).toBe(false)
    expect(isInsideDir(dir, dir)).toBe(false)
    expect(isInsideDir(dir, `${dir}/`)).toBe(false)
    expect(isInsideDir(dir, `${dir}-other/out-a.log`)).toBe(false)
    expect(isInsideDir(dir, '/etc/passwd')).toBe(false)
    expect(isInsideDir(dir, `${dir}/out\0.log`)).toBe(false)
    expect(isInsideDir('', '/out-a.log')).toBe(false)
  })

  test('the file for an output is named after the tool call, in plain characters', () => {
    expect(digestPath('/d', 'toolu_01AbC')).toBe('/d/out-toolu_01AbC.log')
    expect(digestPath('/d', '../../etc/passwd')).toBe('/d/out-______etc_passwd.log')
    expect(normalizeCommand('  npm   test \n -- --run ')).toBe('npm test -- --run')
  })
})

describe('subagent spawns', () => {
  const spawn = { subagentType: 'Explore', model: undefined, parentModel: 'claude-opus-5-5', isFork: false, isTeammate: false, isWorkflow: false }

  test('an Explore spawn under Opus or Fable may run on Sonnet', () => {
    expect(decideSpawn(spawn, [], 'find auth', 0)).toEqual({ qualifies: true, why: 'ok', target: 'sonnet' })
    expect(decideSpawn({ ...spawn, parentModel: 'claude-fable-5-1' }, [], 'find auth', 0).target).toBe('sonnet')
  })

  test('only what is listed is touched: the list is of what is allowed', () => {
    expect(ALLOWED_TYPES).toEqual(['Explore'])
    expect(decideSpawn({ ...spawn, subagentType: 'general-purpose' }, [], 'x', 0).why).toBe('notlisted')
    expect(decideSpawn({ ...spawn, subagentType: 'tokenomics:scout' }, [], 'x', 0).why).toBe('notlisted')
  })

  test('forks, teammates, workflow agents and spawns that name a model are left alone', () => {
    expect(decideSpawn({ ...spawn, isFork: true }, [], 'x', 0).why).toBe('fork')
    expect(decideSpawn({ ...spawn, isTeammate: true }, [], 'x', 0).why).toBe('teammate')
    expect(decideSpawn({ ...spawn, isWorkflow: true }, [], 'x', 0).why).toBe('workflow')
    expect(decideSpawn({ ...spawn, model: 'opus' }, [], 'x', 0).why).toBe('explicit')
  })

  test('a parent that is already light is not lowered further', () => {
    expect(decideSpawn({ ...spawn, parentModel: 'claude-sonnet-5-5' }, [], 'x', 0)).toEqual({ qualifies: false, why: 'parentlight', target: null })
    expect(decideSpawn({ ...spawn, parentModel: 'claude-haiku-5-5' }, [], 'x', 0).qualifies).toBe(false)
    expect(lighterTarget('default')).toBeNull()
  })

  test('asking for the same thing again soon is the first answer not being enough: it is not lowered', () => {
    const recent = [{ type: 'Explore', description: 'find where the login handler is defined', turn: 4 }]
    expect(decideSpawn(spawn, recent, 'find where the login handler is defined', 4 + REDELEGATION_TURNS).why).toBe('redelegated')
    expect(decideSpawn(spawn, recent, 'find where the login handler is defined', 5 + REDELEGATION_TURNS).qualifies).toBe(true)
    expect(decideSpawn(spawn, recent, 'list the database migrations', 5).qualifies).toBe(true)
    expect(decideSpawn(spawn, [{ ...recent[0]!, type: 'Plan' }], 'find where the login handler is defined', 5).qualifies).toBe(true)
  })

  test('texts are told apart by their pairs of characters', () => {
    expect(similarity('abcdef', 'abcdef')).toBe(1)
    expect(similarity('abcdef', 'uvwxyz')).toBe(0)
    expect(similarity('', 'abc')).toBe(0)
    expect(similarity('ログインの処理はどこ', 'ログインの処理を探して')).toBeGreaterThan(0.3)
  })

  test('a subagent type is kept in the ledger only if the engine or this plugin gave the name; any other could carry a project’s', () => {
    expect(typeTag('Explore')).toBe('Explore')
    expect(typeTag('general-purpose')).toBe('general-purpose')
    expect(typeTag('tokenomics:scout')).toBe('tokenomics:scout')
    expect(typeTag('acme-billing-reviewer')).toBe('custom')
    expect(typeTag('my agent/with path')).toBe('custom')
    expect(typeTag('acme:billing-reviewer')).toBe('plugin')
    expect(typeTag('tokenomics:something-else')).toBe('plugin')
  })
})

describe('moments', () => {
  const base = { text: 'ログインのテストを直してください', previous: 'ログインの処理を調べてください', touched: ['src/auth/login.ts'], contextTokens: 80_000, idleMs: 10_000, ttlMs: 300_000 }

  test('a change of subject that says so, in a big conversation, would have been suggested', () => {
    const s = topicShift({ ...base, text: '別件ですが、請求書のPDF出力を作ってください' })
    expect(s.reasons).toContain('keyword')
    expect(s.wouldFire).toBe(true)
    expect(topicShift({ ...base, text: 'unrelated, but add a billing page' }).wouldFire).toBe(true)
  })

  test('the same words in a small conversation are not worth a suggestion', () => {
    const s = topicShift({ ...base, text: '別件ですが、請求書のPDF出力を作ってください', contextTokens: 20_000 })
    expect(s.score).toBe(2)
    expect(s.wouldFire).toBe(false)
    expect(topicShift({ ...base, text: '別件ですが…', contextTokens: null }).wouldFire).toBe(false)
  })

  test('a long pause alone is a doubt, not a decision; with a different subject it is a decision', () => {
    const gap = topicShift({ ...base, idleMs: 400_000 })
    expect(gap.reasons).toEqual(['gap'])
    expect(gap.isUncertain).toBe(true)
    expect(gap.wouldFire).toBe(false)
    const both = topicShift({ ...base, idleMs: 400_000, text: 'database schema migration plan for the orders table' })
    expect(both.reasons).toContain('gap')
    expect(both.reasons).toContain('lowsim')
    expect(both.wouldFire).toBe(true)
  })

  test('naming files the conversation has not touched is a sign; naming one it has is not', () => {
    const other = topicShift({ ...base, text: 'billing/invoice.ts のレイアウトを見てください' })
    expect(other.reasons).toContain('nofile')
    const same = topicShift({ ...base, text: 'src/auth/login.ts のテストを直してください' })
    expect(same.reasons).not.toContain('nofile')
    const byName = topicShift({ ...base, text: 'login.ts の続きをお願いします' })
    expect(byName.reasons).not.toContain('nofile')
    expect(topicShift({ ...base, touched: [], text: 'billing/invoice.ts を見て' }).reasons).not.toContain('nofile')
  })

  test('paths are found in a sentence', () => {
    expect(pathsIn('see src/app/main.tsx and also README.md, not 1.2.3')).toEqual(['src/app/main.tsx', 'README.md'])
  })

  test('a model is asked about the doubtful case only rarely', () => {
    const doubt = topicShift({ ...base, idleMs: 400_000 })
    const ok = { promptsSince: CLASSIFY.everyPrompts, asked: 0, contextTokens: 80_000 }
    expect(shouldClassify(doubt, ok)).toBe(true)
    expect(shouldClassify(doubt, { ...ok, promptsSince: 3 })).toBe(false)
    expect(shouldClassify(doubt, { ...ok, asked: CLASSIFY.perSession })).toBe(false)
    expect(shouldClassify(doubt, { ...ok, contextTokens: 45_000 })).toBe(false)
    expect(shouldClassify(topicShift({ ...base, text: '別件ですが…' }), ok)).toBe(false)
  })

  test('a heavy level is spoken of when reached, and again only if it deepens', () => {
    expect(risen(null, 'notice')).toBe('notice')
    expect(risen('notice', 'notice')).toBeNull()
    expect(risen('notice', 'strong')).toBe('strong')
    expect(risen('strong', 'notice')).toBeNull()
    expect(risen('notice', null)).toBeNull()
  })

  test('a prompt after a pause longer than the cache lives, on a big conversation, costs the difference', () => {
    const cold = coldReturn(400_000, 300_000, 150_000, 'claude-opus-5-5')
    expect(cold.isCold).toBe(true)
    expect(Math.round((cold.penaltyUsd ?? 0) * 100) / 100).toBe(0.72)
    expect(coldReturn(100_000, 300_000, 150_000, 'claude-opus-5-5').isCold).toBe(false)
    expect(coldReturn(400_000, 300_000, 30_000, 'claude-opus-5-5').isCold).toBe(false)
    expect(coldReturn(null, 300_000, 150_000, 'claude-opus-5-5').isCold).toBe(false)
    expect(coldReturn(400_000, 300_000, 150_000, 'default')).toEqual({ isCold: true, penaltyUsd: null })
  })

  test('what starting fresh would spare is ten warm reads of the conversation', () => {
    expect(Math.round((clearStakeUsd(100_000, 'claude-opus-5-5') ?? 0) * 100) / 100).toBe(0.2)
    expect(clearStakeUsd(null, 'claude-opus-5-5')).toBeNull()
    expect(clearStakeUsd(100_000, 'default')).toBeNull()
    expect(ANSWER_TURNS).toBe(3)
  })
})

describe('usage', () => {
  const usage = (read: number, write: number, input = 2) => ({ input_tokens: input, output_tokens: 50, cache_read_input_tokens: read, cache_creation_input_tokens: write })

  test('the cache share is what the cache served of the prompt', () => {
    expect(cacheShare(usage(27_000, 100))).toBeGreaterThan(0.99)
    expect(cacheShare(usage(0, 20_000))).toBe(0)
    expect(cacheShare(usage(0, 0, 0))).toBe(0)
  })

  test('pauses and conversations fall into a few buckets', () => {
    expect(idleBucket(30_000)).toBe('lt1m')
    expect(idleBucket(60_000)).toBe('1to5m')
    expect(idleBucket(5 * 60_000)).toBe('5to15m')
    expect(idleBucket(15 * 60_000)).toBe('15to60m')
    expect(idleBucket(2 * 3_600_000)).toBe('gt60m')
    expect(contextBucket(49_999)).toBe('lt50k')
    expect(contextBucket(50_000)).toBe('50to100k')
    expect(contextBucket(150_000)).toBe('100to200k')
    expect(contextBucket(900_000)).toBe('gt200k')
  })

  test('a turn is cold if it came after the cache could have lapsed and wrote most of its prompt again', () => {
    expect(wasCold(usage(5_000, 90_000), 400_000, 300_000)).toBe(true)
    expect(wasCold(usage(90_000, 500), 400_000, 300_000)).toBe(false)
    expect(wasCold(usage(5_000, 90_000), 100_000, 300_000)).toBe(false)
    expect(wasCold(usage(5_000, 90_000), null, 300_000)).toBe(false)
  })
})

describe('nudges', () => {
  const c = (over: Partial<Candidate> = {}): Candidate => ({ measure: 'C2', tag: 'notice', turn: 5, ctx: 120_000, stakeMilliUsd: 200, needsCold: false, ...over })
  const now = { turn: 5, lastShownTurn: null, isSubscription: false, isColdTurn: false }

  test('one suggestion is made, the most pressing; the others are held back and counted as having been wanted', () => {
    const strong = c({ tag: 'strong' })
    const shift = c({ measure: 'C1', tag: 'keyword' })
    const choice = chooseNudge([c(), shift, strong], now)
    expect(choice.shown).toBe(strong)
    expect(choice.held.map(h => [h.candidate.measure, h.why])).toEqual([['C2', 'multi'], ['C1', 'multi']])
    expect(chooseNudge([c(), shift], now).shown).toBe(shift)
  })

  test('on an API key a suggestion that would spare under five cents is held back; on a subscription tokens alone decide', () => {
    const small = c({ measure: 'C1', tag: 'keyword', stakeMilliUsd: MIN_STAKE_MILLI - 1 })
    expect(chooseNudge([small], now)).toEqual({ shown: null, held: [{ candidate: small, why: 'stake' }] })
    expect(chooseNudge([small], { ...now, isSubscription: true }).shown).toBe(small)
    expect(chooseNudge([c({ stakeMilliUsd: MIN_STAKE_MILLI })], now).shown).not.toBeNull()
    // A model with no price is not held back for want of one.
    expect(chooseNudge([c({ stakeMilliUsd: null })], now).shown).not.toBeNull()
  })

  test('not twice within three turns', () => {
    const one = c()
    expect(chooseNudge([one], { ...now, lastShownTurn: 5 - MIN_GAP_TURNS + 1 })).toEqual({ shown: null, held: [{ candidate: one, why: 'gap' }] })
    expect(chooseNudge([one], { ...now, lastShownTurn: 5 - MIN_GAP_TURNS }).shown).toBe(one)
  })

  test('one that speaks of a lapsed cache is made only if the turn did re-read the conversation', () => {
    const cold = c({ measure: 'C3', tag: '50to100k', needsCold: true })
    expect(chooseNudge([cold], now)).toEqual({ shown: null, held: [] })
    expect(chooseNudge([cold], { ...now, isColdTurn: true }).shown).toBe(cold)
  })

  test('one left unmade for more than two turns is stale', () => {
    expect(chooseNudge([c({ turn: 5 - CANDIDATE_TURNS - 1 })], now).shown).toBeNull()
    expect(chooseNudge([c({ turn: 5 - CANDIDATE_TURNS })], now).shown).not.toBeNull()
  })

  test('the lines say what is happening in a few words, and dollars only off a subscription', () => {
    expect(nudgeLine(c(), false)).toBe('会話が重くなってきました（返信のたびに約 120k tok を読み直します）。区切りのよいところで /compact を。')
    expect(nudgeLine(c({ tag: 'strong' }), false)).toContain('/clear')
    expect(nudgeLine(c({ measure: 'C1', tag: 'keyword' }), false)).toContain('今の回答も消える')
    // Where /clear writes its own note, the person is not asked to ask for one first.
    const noted = nudgeLine(c({ measure: 'C1', tag: 'keyword' }), false, null, true)
    expect(noted).toContain('要点は /clear のときに自動でメモに残ります')
    expect(noted).not.toContain('/tokenomics handoff')
    const cold = c({ measure: 'C3', tag: '50to100k', ctx: 80_000 })
    expect(nudgeLine(cold, false, 400)).toBe('しばらく空いたため、会話全体（約 80k tok）を読み直しました（約 $0.40）。続きが別件なら、/clear が一番軽くなります。')
    expect(nudgeLine(cold, true, 400)).not.toContain('$')
    expect(nudgeLine(cold, false, null)).not.toContain('$')
    // Nothing in any of them is typed for the person, and none tells them to press anything.
    for (const line of [nudgeLine(c(), false), nudgeLine(cold, false), DEMO_LINE]) expect(line).not.toMatch(/Enter|押して/)
  })

  test('the short lines, for the cat’s card, say the same moment and the same way out in fewer cells', () => {
    expect(nudgeShort(c(), false)).toBe('重くなってきました（毎回 約120k tok を読み直し）。区切りで /compact を。')
    expect(nudgeShort(c({ tag: 'strong' }), false)).toContain('/clear')
    expect(nudgeShort(c({ measure: 'C1', tag: 'keyword' }), false)).toContain('今の回答は消えます')
    const cold = c({ measure: 'C3', tag: '50to100k', ctx: 80_000 })
    expect(nudgeShort(cold, false, 400)).toBe('空いたため会話全体（約80k tok）を読み直しました（約 $0.40）。別件なら /clear が一番軽いです。')
    expect(nudgeShort(cold, true, 400)).not.toContain('$')
    expect(nudgeShort(cold, false, null)).not.toContain('$')
    for (const [short, long] of [
      [nudgeShort(c(), false), nudgeLine(c(), false)],
      [nudgeShort(c({ tag: 'strong' }), false), nudgeLine(c({ tag: 'strong' }), false)],
      [nudgeShort(cold, false, 400), nudgeLine(cold, false, 400)],
      [nudgeShort(c({ measure: 'C1', tag: 'keyword' }), false), nudgeLine(c({ measure: 'C1', tag: 'keyword' }), false)],
      [DEMO_SHORT, DEMO_LINE],
    ] as const) {
      expect(cellWidth(short)).toBeLessThan(cellWidth(long))
      expect(short).not.toMatch(/Enter|押して/)
    }
  })
})

describe('cells', () => {
  test('a Japanese character takes two cells, anything else one', () => {
    expect(cellWidth('')).toBe(0)
    expect(cellWidth('abc /clear')).toBe(10)
    expect(cellWidth('重く')).toBe(4)
    // （ 約 and ） 。 are two each; the space, 1 and k one each.
    expect(cellWidth('（約 1k）。')).toBe(11)
    expect(cellWidth('ｱ')).toBe(1)
    expect(cellWidth('ＡＢ')).toBe(4)
  })

  test('rows are counted on the safe side: a row holds one cell less than the box', () => {
    expect(wrappedRows('', 34)).toBe(0)
    expect(wrappedRows('a'.repeat(33), 34)).toBe(1)
    expect(wrappedRows('a'.repeat(34), 34)).toBe(2)
    // 17 full-width characters are 34 cells: they do not fit one row of 33.
    expect(wrappedRows('あ'.repeat(16), 34)).toBe(1)
    expect(wrappedRows('あ'.repeat(17), 34)).toBe(2)
    expect(wrappedRows('あ', 0)).toBe(2)
  })
})
