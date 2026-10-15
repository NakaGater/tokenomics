import { describe, expect, test } from 'claude-code/testing'

import {
  ASSUMED_TURNS_AFTER,
  PRICES,
  coldPenaltyUsd,
  coldTurnUsd,
  contextFactor,
  heavyLevel,
  keptOutUsd,
  milliUsd,
  modelFamily,
  warmTurnUsd,
} from '../hooks/lib/core/economics'
import { shortHash } from '../hooks/lib/core/hash'
import {
  MAX_BYTES,
  MAX_DAYS,
  MAX_RECENT,
  type Ledger,
  type LedgerEvent,
  append,
  appendRaw,
  dayOf,
  digestHealth,
  digestThreshold,
  emptyLedger,
  parseLedger,
  sanitize,
  savingsToday,
  sessionKey,
  sumCounts,
} from '../hooks/lib/core/ledger'
import { DEFAULT_OPTIONS, cacheTtlMs, parseOptions } from '../hooks/lib/core/options'
import { savedAll, savingsRows, sessionSavingRows } from '../hooks/lib/status'
import { BREAKER_LIMIT, MEASURES, MEASURE_IDS, armOf, failed, isTripped, modeOf, succeeded } from '../hooks/lib/core/policy'
import type { Savings } from '../types'

const DAY = 86_400_000
/** A figure to a few decimals: the kit has no "close to", and a price is a float. */
const round = (x: number | null, digits: number): number | null => (x === null ? null : Number(x.toFixed(digits)))
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
/** A day with nothing saved. */
const NOTHING: Savings = { digests: 0, tokens: 0, milliUsd: 0, wouldFire: 0, recovered: 0, forks: 0, keptTokens: 0, keptMilliUsd: 0, forkReaders: 0, forkRereads: 0, forkCostMilliUsd: 0, forkLosses: 0, subCuts: 0, subTokens: 0, flowReqs: 0, flowTokens: 0, flowKeptTokens: 0, flowMicroUsd: 0 }

describe('options', () => {
  test('a manifest with nothing set gives the defaults', () => {
    expect(parseOptions(undefined)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions({})).toEqual(DEFAULT_OPTIONS)
  })

  test('values that fit are taken, and numbers are held to their range', () => {
    const o = parseOptions({ hud: false, digest: 'observe', delegation: 'auto', steer: 'auto', batch: 'off', nudges: 'off', handoffNote: false, holdoutPercent: 250, cacheTtlMinutes: 500 })
    expect(o).toEqual({ hud: false, digest: 'observe', delegation: 'auto', steer: 'auto', batch: 'off', nudges: 'off', handoffNote: false, holdoutPercent: 100, cacheTtlMinutes: 120 })
    expect(parseOptions({ cacheTtlMinutes: -3 }).cacheTtlMinutes).toBe(0)
  })

  test('a value that does not fit counts as unset', () => {
    const o = parseOptions({ hud: 'yes', digest: 'maybe', nudges: 'loud', handoffNote: 'sometimes', holdoutPercent: Number.NaN, cacheTtlMinutes: 'five' })
    expect(o).toEqual(DEFAULT_OPTIONS)
  })
})

describe('the cache’s lifetime', () => {
  test('left at 0 it is told from the account: five minutes on an API key, an hour on a subscription', () => {
    expect(cacheTtlMs(DEFAULT_OPTIONS, false)).toBe(5 * 60_000)
    expect(cacheTtlMs(DEFAULT_OPTIONS, true)).toBe(60 * 60_000)
  })

  test('a number set by the person is what it is, whatever the account', () => {
    expect(cacheTtlMs({ ...DEFAULT_OPTIONS, cacheTtlMinutes: 15 }, true)).toBe(15 * 60_000)
    expect(cacheTtlMs({ ...DEFAULT_OPTIONS, cacheTtlMinutes: 15 }, false)).toBe(15 * 60_000)
  })
})

describe('economics', () => {
  test('the model families are read off any spelling of a model id', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('opus')
    expect(modelFamily('sonnet[1m]')).toBe('sonnet')
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku')
    expect(modelFamily('claude-fable-5-1')).toBe('fable')
    expect(modelFamily('default')).toBeNull()
    expect(modelFamily(undefined)).toBeNull()
  })

  test('a turn over a warm cache costs the read price; a cold one the write price: 25 times as much', () => {
    expect(round(warmTurnUsd(100_000, 'claude-opus-5-5'), 6)).toBe(0.02)
    expect(round(coldTurnUsd(100_000, 'claude-opus-5-5'), 6)).toBe(0.5)
    expect(round(coldPenaltyUsd(100_000, 'claude-opus-5-5'), 6)).toBe(0.48)
    expect(round(coldTurnUsd(100_000, 'claude-opus-5-5')! / warmTurnUsd(100_000, 'claude-opus-5-5')!, 6)).toBe(25)
    expect(round(warmTurnUsd(100_000, 'claude-sonnet-5-5'), 6)).toBe(0.01)
    expect(round(coldTurnUsd(100_000, 'claude-sonnet-5-5', '1h'), 6)).toBe(0.4)
  })

  test('a conversation of 700k tokens that has gone cold costs $3.50 to write again on Opus', () => {
    expect(round(coldTurnUsd(700_000, 'claude-opus-5-5'), 6)).toBe(3.5)
  })

  test('a model not in the list has no price, and Haiku costs five times as much over 100k', () => {
    expect(warmTurnUsd(100_000, 'default')).toBeNull()
    expect(coldPenaltyUsd(100_000, undefined)).toBeNull()
    expect(round(warmTurnUsd(100_000, 'haiku'), 6)).toBe(0.001)
    expect(round(warmTurnUsd(200_000, 'haiku'), 6)).toBe(0.01)
  })

  test('a token of context is worth more the more turns follow it', () => {
    expect(round(contextFactor(0), 6)).toBe(1.25)
    expect(round(contextFactor(30), 6)).toBe(2.75)
    expect(round(contextFactor(30, '1h'), 6)).toBe(3.5)
    // 6.5k tokens kept out of the conversation for 30 turns, on Opus: about seven cents.
    expect(round(keptOutUsd(6_500, 'claude-opus-5-5', ASSUMED_TURNS_AFTER), 4)).toBe(0.0715)
    expect(keptOutUsd(6_500, 'default', 30)).toBeNull()
  })

  test('a conversation is heavy by what a turn costs to read it: 100k and 200k on Opus, twice that on Sonnet', () => {
    expect(heavyLevel(90_000, 'claude-opus-5-5', false)).toBeNull()
    expect(heavyLevel(100_000, 'claude-opus-5-5', false)).toBe('notice')
    expect(heavyLevel(200_000, 'claude-opus-5-5', false)).toBe('strong')
    expect(heavyLevel(150_000, 'claude-sonnet-5-5', false)).toBeNull()
    expect(heavyLevel(200_000, 'claude-sonnet-5-5', false)).toBe('notice')
    expect(heavyLevel(400_000, 'claude-sonnet-5-5', false)).toBe('strong')
  })

  test('on a subscription, or for a model not in the list, size alone decides', () => {
    expect(heavyLevel(100_000, 'claude-sonnet-5-5', true)).toBe('notice')
    expect(heavyLevel(200_000, 'claude-sonnet-5-5', true)).toBe('strong')
    expect(heavyLevel(120_000, 'default', false)).toBe('notice')
    expect(heavyLevel(50_000, 'default', false)).toBeNull()
  })

  test('dollars go into the ledger as whole thousandths', () => {
    expect(milliUsd(0.0715)).toBe(72)
    expect(milliUsd(null)).toBe(0)
    expect(PRICES.opus.write5m / PRICES.opus.input).toBe(1.25)
    expect(round(PRICES.opus.read / PRICES.opus.input, 6)).toBe(0.05)
  })
})

describe('policy', () => {
  const treat = (over: Partial<typeof DEFAULT_OPTIONS> = {}) => ({ ...DEFAULT_OPTIONS, ...over })

  test('every measure has a row, owned by one of the settings', () => {
    expect(MEASURE_IDS).toEqual(['A1', 'B1', 'B2', 'B3', 'B6', 'B7', 'C1', 'C2', 'C3'])
    for (const id of MEASURE_IDS) expect(['digest', 'delegation', 'steer', 'batch', 'nudges']).toContain(MEASURES[id].option)
  })

  test('the defaults: the digest acts, the subagent and suggestion measures watch', () => {
    const o = treat()
    expect(modeOf('A1', o, 'treat')).toBe('auto')
    expect(modeOf('B1', o, 'treat')).toBe('observe')
    expect(modeOf('B2', o, 'treat')).toBe('observe')
    expect(modeOf('B6', o, 'treat')).toBe('observe')
    expect(modeOf('C1', o, 'treat')).toBe('observe')
  })

  test('a setting turns its measures to the mode it names, where the measure has that mode', () => {
    expect(modeOf('B1', treat({ delegation: 'auto' }), 'treat')).toBe('auto')
    expect(modeOf('B2', treat({ delegation: 'auto' }), 'treat')).toBe('auto')
    // Replacing Explore is only watched in this build, whatever the setting says.
    expect(modeOf('B3', treat({ delegation: 'auto' }), 'treat')).toBe('observe')
    expect(modeOf('A1', treat({ digest: 'observe' }), 'treat')).toBe('observe')
    // Turning calls back has its own setting: the delegation one does not reach it.
    expect(modeOf('B6', treat({ delegation: 'auto' }), 'treat')).toBe('observe')
    expect(modeOf('B6', treat({ steer: 'auto' }), 'treat')).toBe('auto')
    expect(modeOf('B1', treat({ steer: 'auto' }), 'treat')).toBe('observe')
  })

  test('the sentence about reads (B7) has its own setting, which is on unless it is turned down, and is not reached by the others', () => {
    expect(modeOf('B7', treat(), 'treat')).toBe('auto')
    expect(modeOf('B7', treat({ batch: 'observe' }), 'treat')).toBe('observe')
    expect(modeOf('B7', treat({ batch: 'off' }), 'treat')).toBe('off')
    expect(modeOf('B7', treat({ steer: 'auto', delegation: 'auto', digest: 'off' }), 'treat')).toBe('auto')
    expect(modeOf('B6', treat({ batch: 'auto' }), 'treat')).toBe('observe')
    // A person held back is told nothing more than anyone: the sentence is only watched for.
    expect(modeOf('B7', treat(), 'control')).toBe('observe')
  })

  test('the digest, where there is no place of the person’s own to keep its copies, only watches', () => {
    expect(modeOf('A1', treat(), 'treat', false)).toBe('observe')
    expect(modeOf('A1', treat({ digest: 'off' }), 'treat', false)).toBe('off')
    expect(modeOf('B1', treat({ delegation: 'auto' }), 'treat', false)).toBe('auto')
  })

  test('off is always honoured', () => {
    expect(modeOf('A1', treat({ digest: 'off' }), 'treat')).toBe('off')
    expect(modeOf('B3', treat({ delegation: 'off' }), 'treat')).toBe('off')
    expect(modeOf('C2', treat({ nudges: 'off' }), 'control')).toBe('off')
  })

  test('the held-back arm never does more than watch', () => {
    expect(modeOf('A1', treat(), 'control')).toBe('observe')
    expect(modeOf('B1', treat({ delegation: 'auto' }), 'control')).toBe('observe')
    expect(modeOf('B6', treat({ steer: 'auto' }), 'control')).toBe('observe')
  })

  test('the arm is the same for the same person, and the share held back is about what was asked', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `person-${i}`)
    expect(armOf('person-7', 20)).toBe(armOf('person-7', 20))
    const held = ids.filter(id => armOf(id, 20) === 'control').length
    expect(held).toBeGreaterThan(300)
    expect(held).toBeLessThan(500)
    expect(ids.every(id => armOf(id, 0) === 'treat')).toBe(true)
    expect(ids.every(id => armOf(id, 100) === 'control')).toBe(true)
  })

  test('a measure that fails three times running stops, and a success starts the count again', () => {
    let b = {}
    for (let i = 0; i < BREAKER_LIMIT - 1; i += 1) b = failed(b, 'A1')
    expect(isTripped(b, 'A1')).toBe(false)
    expect(isTripped(succeeded(b, 'A1'), 'A1')).toBe(false)
    expect(isTripped(failed(succeeded(b, 'A1'), 'A1'), 'A1')).toBe(false)
    b = failed(b, 'A1')
    expect(isTripped(b, 'A1')).toBe(true)
    expect(isTripped(b, 'B1')).toBe(false)
  })
})

describe('ledger', () => {
  const fired: LedgerEvent = { kind: 'fired', measure: 'A1', mode: 'auto', arm: 'treat', n: { inChars: 24_000, outChars: 3_600, savedTokens: 5_100, savedMilliUsd: 72 } }

  test('an event is counted by measure, kind, mode and word, and its numbers are summed', () => {
    let l: Ledger = emptyLedger
    l = append(l, fired, NOW, 'sid')
    l = append(l, fired, NOW + 1000, 'sid')
    l = append(l, { kind: 'would', measure: 'B1', mode: 'observe', arm: 'treat', tag: 'Explore' }, NOW + 2000, 'sid')
    const day = l.days[0]!
    expect(day.day).toBe(dayOf(NOW))
    expect(day.counts['A1:fired:auto']).toBe(2)
    expect(day.counts['B1:would:observe:Explore']).toBe(1)
    expect(day.sums['A1:savedTokens']).toBe(10_200)
    expect(l.recent).toHaveLength(3)
  })

  test('the ledger keeps no content: a word with a path, a space or a command in it is refused, and so is a bad number', () => {
    expect(sanitize({ ...fired, tag: '/Users/someone/project/secret.ts' })).toBeNull()
    expect(sanitize({ ...fired, tag: 'git commit -m fix' })).toBeNull()
    expect(sanitize({ ...fired, tag: 'C:\\work\\x' })).toBeNull()
    expect(sanitize({ ...fired, tag: 'a'.repeat(41) })).toBeNull()
    expect(sanitize({ ...fired, n: { inChars: Number.NaN } })).toBeNull()
    expect(sanitize({ ...fired, n: { 'a b': 1 } })).toBeNull()
    expect(sanitize({ ...fired, measure: 'a path' })).toBeNull()
    expect(sanitize({ ...fired, kind: 'prompt' as never })).toBeNull()
    expect(sanitize({ ...fired, tag: 'tokenomics:scout' })).not.toBeNull()
    const l = append(emptyLedger, { ...fired, tag: '/Users/someone/project' }, NOW, 'sid')
    expect(l).toBe(emptyLedger)
  })

  test('the session is kept as a short hash, never whole', () => {
    const id = '9a9a7245-c2fa-4aba-b67d-45ab91e98e59'
    expect(sessionKey(id)).toMatch(/^[0-9a-f]{8}$/)
    expect(sessionKey(id)).toBe(shortHash(id))
    expect(sessionKey(id)).not.toBe(sessionKey('another'))
    const l = append(emptyLedger, fired, NOW, sessionKey(id))
    expect(JSON.stringify(l)).not.toContain(id)
  })

  test('only the last 14 days and the last 200 events are kept', () => {
    let l: Ledger = emptyLedger
    for (let i = 0; i < 20; i += 1) l = append(l, fired, NOW + i * DAY, 'sid')
    expect(l.days).toHaveLength(MAX_DAYS)
    expect(l.days[0]!.day).toBe(dayOf(NOW + 6 * DAY))
    for (let i = 0; i < 300; i += 1) l = append(l, fired, NOW + 19 * DAY + i, 'sid')
    expect(l.recent.length).toBeLessThanOrEqual(MAX_RECENT)
  })

  test('however many kinds of event arrive, the ledger stays under its size', () => {
    let l: Ledger = emptyLedger
    for (let i = 0; i < 3000; i += 1) {
      l = append(l, { kind: 'signal', measure: 'S', mode: 'observe', arm: 'treat', tag: `tag${i}`, n: { [`n${i}`]: i } }, NOW + i, 'sid')
    }
    expect(JSON.stringify(l).length).toBeLessThanOrEqual(MAX_BYTES)
    expect(Object.keys(l.days[0]!.counts).length).toBeLessThanOrEqual(301)
  })

  test('what the store gives back is read defensively, and a good ledger survives the trip', () => {
    expect(parseLedger(undefined)).toEqual(emptyLedger)
    expect(parseLedger('text')).toEqual(emptyLedger)
    expect(parseLedger({ v: 2, days: [] })).toEqual(emptyLedger)
    const l = append(emptyLedger, fired, NOW, 'sid')
    expect(parseLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
    const dirty = { v: 1, days: [{ day: 'not a day', counts: {}, sums: {} }, l.days[0]], recent: [{ ...l.recent[0], tag: '/etc/passwd' }, { t: 'x' }] }
    const read = parseLedger(dirty)
    expect(read.days).toHaveLength(1)
    expect(read.recent).toHaveLength(0)
  })

  test('events held back to be written later are added on top of what the store holds', () => {
    const stored = append(emptyLedger, fired, NOW, 'a')
    const merged = appendRaw(stored, { ...fired, t: NOW + 5, sid: 'b' })
    expect(merged.days[0]!.counts['A1:fired:auto']).toBe(2)
    expect(merged.recent.map(r => r.sid)).toEqual(['a', 'b'])
  })

  test('the digest is judged by how often the model had to go back for the rest', () => {
    let l: Ledger = emptyLedger
    const outcome = (tag: string): LedgerEvent => ({ kind: 'outcome', measure: 'A1', mode: 'auto', arm: 'treat', tag })
    for (let i = 0; i < 20; i += 1) l = append(l, fired, NOW + i, 's')
    expect(digestHealth(l, NOW + 100)).toEqual({ fired: 20, recovered: 0, rate: 0 })
    expect(digestThreshold(l, NOW + 100, 9000)).toBe(9000)
    for (let i = 0; i < 6; i += 1) l = append(l, outcome(i % 2 === 0 ? 'rerun' : 'readback'), NOW + 200 + i, 's')
    expect(digestHealth(l, NOW + 300).recovered).toBe(6)
    expect(digestThreshold(l, NOW + 300, 9000)).toBe(18_000)
    for (let i = 0; i < 6; i += 1) l = append(l, outcome('rerun'), NOW + 400 + i, 's')
    expect(digestThreshold(l, NOW + 500, 9000)).toBeNull()
  })

  test('too few digests to judge leave the size alone, and a quiet week is no evidence', () => {
    const l = append(append(emptyLedger, fired, NOW, 's'), { kind: 'outcome', measure: 'A1', mode: 'auto', arm: 'treat', tag: 'rerun' }, NOW + 1, 's')
    expect(digestThreshold(l, NOW + 2, 9000)).toBe(9000)
    expect(digestThreshold(emptyLedger, NOW, 9000)).toBe(9000)
  })

  test('today’s savings are summed for the pane', () => {
    let l: Ledger = emptyLedger
    l = append(l, fired, NOW, 's')
    l = append(l, fired, NOW + 1, 's')
    l = append(l, { kind: 'would', measure: 'C2', mode: 'observe', arm: 'treat', tag: 'notice' }, NOW + 2, 's')
    l = append(l, fired, NOW - 2 * DAY, 's')
    expect(savingsToday(l, NOW + 3)).toEqual({ ...NOTHING, digests: 2, tokens: 10_200, milliUsd: 144, wouldFire: 1 })
    expect(sumCounts(l, NOW + 3, 7, k => k.startsWith('A1:fired:'))).toBe(3)
  })

  test('what work handed to the plugin’s skills and agents kept out is summed apart from the digest’s, for its own kinds only', () => {
    const kept = (tag: string): LedgerEvent => ({ kind: 'signal', measure: 'B1', mode: 'observe', arm: 'treat', tag, n: { keptTokens: 9_800, readTokens: 10_000, reportTokens: 200, keptMilliUsd: 300, scoutMicroUsd: 2_000 } })
    const note = (kind: 'signal' | 'outcome', tag: string): LedgerEvent => ({ kind, measure: 'B1', mode: 'observe', arm: 'treat', tag })
    let l: Ledger = emptyLedger
    l = append(l, fired, NOW, 's')
    l = append(l, kept('kept_scout'), NOW + 1, 's')
    l = append(l, kept('kept_test-summary'), NOW + 2, 's')
    l = append(l, kept('kept_scout'), NOW - 2 * DAY, 's')
    l = append(l, note('signal', 'readers_fork_scout'), NOW + 3, 's')
    l = append(l, note('signal', 'readers_tokenomics:scout'), NOW + 3, 's')
    l = append(l, note('signal', 'readers_Explore'), NOW + 3, 's')
    l = append(l, note('signal', 'readers_custom'), NOW + 3, 's')
    l = append(l, note('outcome', 'reread_fork_scout'), NOW + 4, 's')
    l = append(l, note('outcome', 'reread_Explore'), NOW + 4, 's')
    l = append(l, note('outcome', 'lost_fork_scout'), NOW + 4, 's')
    l = append(l, note('outcome', 'lost_Explore'), NOW + 4, 's')
    l = append(l, { kind: 'outcome', measure: 'A1', mode: 'auto', arm: 'treat', tag: 'readback' }, NOW + 4, 's')
    expect(savingsToday(l, NOW + 5)).toEqual({
      ...NOTHING,
      digests: 1,
      tokens: 5_100,
      milliUsd: 72,
      recovered: 1,
      forks: 2,
      keptTokens: 19_600,
      keptMilliUsd: 600,
      forkReaders: 2,
      forkRereads: 1,
      // The two runs of today cost 2 each; a run that gained nothing counts for the plugin's own kinds only.
      forkCostMilliUsd: 4,
      forkLosses: 1,
    })
  })
})

describe('savings rows', () => {
  const day = { ...NOTHING, digests: 3, tokens: 21_000, milliUsd: 115, wouldFire: 2 }
  const handed = { ...NOTHING, forks: 2, keptTokens: 19_600, keptMilliUsd: 600 }

  test('nothing has been done: nothing to show', () => {
    expect(savingsRows(NOTHING, false)).toEqual([])
  })

  test('what was cut is told in tokens and, off a subscription, in dollars; what was only noted is told apart', () => {
    const api = savingsRows(day, false)
    expect(api[0]!.label).toBe('今日の節約（確定）')
    expect(api[0]!.value).toBe('大きな出力を 3 回縮め、約 21k tok を会話に入れずに済みました（見込み約 $0.12）')
    expect(api[1]!.value).toContain('2 回')
    expect(savingsRows(day, true)[0]!.value).toBe('大きな出力を 3 回縮め、約 21k tok を会話に入れずに済みました')
  })

  test('the outputs the model went back for are told beside the cut ones', () => {
    expect(savingsRows({ ...day, recovered: 1 }, true)[0]!.value).toBe('大きな出力を 3 回縮め、約 21k tok を会話に入れずに済みました。あとで全文を取りに戻ったのは 1 回')
  })

  test('the estimate for work handed to a skill or agent is a row of its own, called an estimate; where there are two kinds a row on top adds them up', () => {
    const rows = savingsRows({ ...handed, digests: 3, tokens: 21_000, milliUsd: 115, wouldFire: 2 }, false)
    expect(rows.map(r => r.label)).toEqual(['今日の節約（合計）', '今日の節約（確定）', '今日の節約（推定）', '記録のみ'])
    expect(rows[0]!.value).toBe('約 41k tok ＝ 確定 21k ＋ 推定 20k（今日、この端末のすべてのセッションの分。推定を含む）')
    expect(rows[1]!.value).toContain('約 21k tok')
    expect(rows[2]!.value).toBe('調べものやテストを 2 回任せ、会話に入れずに済んだ読み込みは約 20k tok（控えめな推定）、見込み約 $0.60。任せた先の費用は約 $0.00（入力側）で、差し引き 約 $0.60')
    // One kind alone is its own total: there is nothing to add up.
    expect(savingsRows(handed, true).map(r => r.label)).toEqual(['今日の節約（推定）'])
    expect(savingsRows(handed, true)[0]!.value).toBe('調べものやテストを 2 回任せ、会話に入れずに済んだ読み込みは約 20k tok（控えめな推定）')
  })

  test('the outputs cut inside subagents are a row of their own, and part of the total', () => {
    const sub = { ...NOTHING, subCuts: 4, subTokens: 14_755 }
    expect(savingsRows(sub, false).map(r => r.label)).toEqual(['今日の節約（サブ）'])
    expect(savingsRows(sub, false)[0]!.value).toBe('サブエージェントが読む大きな出力を 4 回縮め、約 15k tok を読まずに済ませました（会話が読むものではない分。上の「確定」には入れていません）')
    const rows = savingsRows({ ...day, subCuts: 4, subTokens: 14_755, forks: 2, keptTokens: 19_600, keptMilliUsd: 600 }, true)
    expect(rows.map(r => r.label)).toEqual(['今日の節約（合計）', '今日の節約（確定）', '今日の節約（推定）', '今日の節約（サブ）', '記録のみ'])
    expect(rows[0]!.value).toContain('約 55k tok ＝ 確定 21k ＋ 推定 20k ＋ サブエージェント内 15k')
  })

  test('the band’s figure is every kind added up, and says whether an estimate is in it', () => {
    expect(savedAll(NOTHING)).toMatchObject({ tokens: 0, isEstimated: false })
    expect(savedAll({ ...day })).toMatchObject({ tokens: 21_000, isEstimated: false })
    expect(savedAll({ ...NOTHING, forks: 2, keptTokens: 19_600 })).toMatchObject({ tokens: 19_600, isEstimated: true })
    expect(savedAll({ ...NOTHING, subCuts: 1, subTokens: 700 })).toMatchObject({ tokens: 700, isEstimated: true })
    expect(savedAll({ ...day, forks: 2, keptTokens: 19_600, subCuts: 4, subTokens: 14_755 })).toMatchObject({ tokens: 55_355, isEstimated: true })
  })

  test('where requests were counted, each kind is what it spared them (延べ), never less than the size it was cut at', () => {
    const spread = { ...day, flowReqs: 40, flowTokens: 400_000 }
    expect(savedAll(spread)).toMatchObject({ tokens: 400_000, isSpread: true })
    // The requests of the day do not reach back to what was cut the evening before: its size stands in.
    expect(savedAll({ ...spread, flowTokens: 5_000 })).toMatchObject({ tokens: 21_000, isSpread: true })
    expect(savedAll({ ...spread, forks: 2, keptTokens: 19_600, flowKeptTokens: 90_000, subCuts: 1, subTokens: 700 })).toMatchObject({ tokens: 490_700, isSpread: true, isEstimated: true })
    expect(savedAll(day).isSpread).toBe(false)
  })

  test('the session’s row is the band’s figure with what it is made of, and is not there when nothing was kept out', () => {
    expect(sessionSavingRows(NOTHING)).toEqual([])
    const [alone] = sessionSavingRows(day)
    expect(alone!.label).toBe('このセッションの節約')
    expect(alone!.value).toBe('約 21k tok（帯の「節約（延べ）」と同じ数字）＝ 確定 21k。/clear で数え直します')
    const [all] = sessionSavingRows({ ...day, flowReqs: 40, flowTokens: 400_000, forks: 2, keptTokens: 19_600, subCuts: 4, subTokens: 14_755 })
    expect(all!.value).toBe('約 434k tok（帯の「節約（延べ）」と同じ数字）＝ 確定 400k ＋ 推定 20k ＋ サブエージェント内 15k。確定と推定は延べ。推定を含む。/clear で数え直します')
  })

  test('the 延べ row counts the requests, tells the dollars off a subscription only, and takes the assumed dollars out of the 確定 row', () => {
    const spread = { ...day, flowReqs: 40, flowTokens: 400_000, flowMicroUsd: 31_000 }
    const rows = savingsRows(spread, false)
    expect(rows.map(r => r.label)).toEqual(['今日の節約（合計）', '今日の節約（延べ）', '今日の節約（確定）', '記録のみ'])
    expect(rows[0]!.value).toBe('約 400k tok ＝ 確定 400k（今日、この端末のすべてのセッションの分。確定と推定は延べ）')
    expect(rows[1]!.value).toContain('のべ 40 回のリクエストに載らずに済みました（延べ約 400k tok、入力側の見込み約 $0.03）')
    // One dollar amount: the measured one.
    expect(rows[2]!.value).toBe('大きな出力を 3 回縮め、約 21k tok を会話に入れずに済みました')
    expect(savingsRows(spread, true)[1]!.value).not.toContain('$')
    // Before any request followed, there is no such row, and the dollars are as they were.
    expect(savingsRows(day, false).map(r => r.label)).toEqual(['今日の節約（確定）', '記録のみ'])
    expect(savingsRows(day, false)[0]!.value).toContain('見込み約 $0.12')
  })

  test('the runs’ own cost is set against what they kept out, and a run that gained nothing is counted', () => {
    const [row] = savingsRows({ ...handed, forkCostMilliUsd: 150, forkLosses: 1 }, false)
    expect(row!.value).toContain('任せた先の費用は約 $0.15（入力側）で、差し引き 約 $0.45')
    expect(row!.value).toContain('報告が読んだ量以上で、得にならなかったのは 1 回')
    // Where the cost was the larger, the balance says so.
    expect(savingsRows({ ...handed, keptMilliUsd: 1, forkCostMilliUsd: 3 }, false)[0]!.value).toContain('差し引き 約 −$0.00')
    expect(savingsRows({ ...handed, keptMilliUsd: 100, forkCostMilliUsd: 300 }, false)[0]!.value).toContain('差し引き 約 −$0.20')
    // On a subscription there are no dollars, but a run that gained nothing is still told.
    expect(savingsRows({ ...handed, forkCostMilliUsd: 150, forkLosses: 2 }, true)[0]!.value).toBe(
      '調べものやテストを 2 回任せ、会話に入れずに済んだ読み込みは約 20k tok（控えめな推定）。報告が読んだ量以上で、得にならなかったのは 2 回',
    )
  })

  test('with it, how often the conversation had to read the same files again', () => {
    const [row] = savingsRows({ ...handed, forkReaders: 2, forkRereads: 1 }, true)
    expect(row!.value).toContain('ファイルを読んだ 2 回のあと、会話側が同じファイルを読み直したのは 1 件')
  })
})
