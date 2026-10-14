import type { SessionContextBreakdown, SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { Facts, ModelRow, Modes, OfferKind } from '../types'

import { THRESHOLDS, computeAdvice, nextAdvice } from '../hooks/lib/advice'
import {
  applyBigOutput,
  applyBoundary,
  applyCleared,
  applyCompacted,
  applyMeasure,
  applyPrompt,
  applySentIn,
  applyStep,
  applyTurn,
  initialFacts,
  noSession,
  pruneDismissed,
  sessionOf,
} from '../hooks/lib/facts'
import { bar, cellWidth, clockLabel, estimateTokens, exactTokens, formatTokens, promptTokens, promptsOf, turnTokens } from '../hooks/lib/format'
import { buildHandoff, clearPointer, formatGit, handoffDir, handoffPath, hasWork, withGit, withPointer } from '../hooks/lib/handoff'
import { heavyFrom } from '../hooks/lib/heavy'
import { FACE, FACE_CELLS, moodOf } from '../hooks/lib/mascot'
import { activeSavings, cappedEffort, fitsWindow, initialModes, lighterModels, tagOf } from '../hooks/lib/modes'
import { OFFER_NAMES, computeOffers, nextOffer, pruneSeen, standingOffers } from '../hooks/lib/offers'
import { isBoundaryCommand } from '../hooks/lib/signals'
import { fillOf, fillTokens } from '../hooks/lib/gauge'
import { report, statusRows } from '../hooks/lib/status'
import { LABEL_CELLS } from '../hooks/ui/pane'

const at = (percent: number, extra: Partial<Facts> = {}): Facts => ({
  ...initialFacts,
  contextPercent: percent,
  contextTokens: percent * 2000,
  contextWindow: 200_000,
  ...extra,
})

const ids = (f: Facts): string[] => computeAdvice(f).map(a => a.id)

describe('format', () => {
  test('tokens read at a glance', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(3200)).toBe('3.2k')
    expect(formatTokens(3000)).toBe('3k')
    expect(formatTokens(48_000)).toBe('48k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  test('the bar fills in tenths and never overflows', () => {
    expect(bar(52)).toBe('▓▓▓▓▓░░░░░')
    expect(bar(0)).toBe('░░░░░░░░░░')
    expect(bar(100)).toBe('▓▓▓▓▓▓▓▓▓▓')
    expect(bar(150)).toBe('▓▓▓▓▓▓▓▓▓▓')
    expect(bar(50, 6)).toBe('▓▓▓░░░')
  })

  test('a turn is what it spent, not what the cache served', () => {
    const turn = turnTokens({
      input_tokens: 900,
      output_tokens: 300,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 2_100_000,
      model: 'm',
    })
    expect(turn.spent).toBe(3200)
    expect(turn.cacheRead).toBe(2_100_000)
  })

  test('estimates and clock labels', () => {
    expect(estimateTokens('a'.repeat(30_000))).toBe(10_000)
    expect(clockLabel('not a time')).toBeUndefined()
    expect(clockLabel(undefined)).toBeUndefined()
    expect(clockLabel('2026-10-09T15:30:00')).toBe('15:30')
  })
})

describe('advice', () => {
  test('says nothing while there is nothing to say', () => {
    expect(ids(initialFacts)).toEqual([])
    expect(ids(at(52))).toEqual([])
    // A heavy conversation is not advice: it is a suggestion, with something to accept.
    expect(ids(at(95))).toEqual([])
  })

  test('limits speak from 80 and warn from 95', () => {
    const limit = (percentUsed: number) => ({ rateLimits: [{ kind: 'five_hour', percentUsed }] })
    expect(ids(at(10, limit(79.9)))).toEqual([])
    const notice = computeAdvice(at(10, limit(82)))[0]
    expect(notice?.id).toBe('limit-five_hour')
    expect(notice?.level).toBe('notice')
    expect(notice?.title).toContain('5時間')
    expect(notice?.title).toContain('82%')
    expect(computeAdvice(at(10, limit(96)))[0]?.level).toBe('warn')
  })

  test('a large tool result is named with where it came from', () => {
    const big = { id: 'tu_1', tool: 'Read', tokens: 14_000, target: 'src/huge.ts' }
    const advice = computeAdvice(at(10, { bigOutput: big }))[0]
    expect(advice?.id).toBe('big-tu_1')
    expect(advice?.title).toContain('14k')
    expect(advice?.detail).toContain('src/huge.ts')
    expect(advice?.detail).toContain('offset')
  })

  test('the most urgent comes first', () => {
    const f = at(92, {
      rateLimits: [{ kind: 'five_hour', percentUsed: 96 }],
      bigOutput: { id: 'tu_2', tool: 'Bash', tokens: 12_000 },
      cacheLapse: { tokens: 58_000 },
    })
    expect(ids(f)).toEqual(['limit-five_hour', 'big-tu_2', 'cache-lapse'])
  })

  test('what the person put off stays off, and comes back when it begins again', () => {
    const limited = at(10, { rateLimits: [{ kind: 'five_hour', percentUsed: 85 }] })
    expect(nextAdvice(limited, [])?.id).toBe('limit-five_hour')
    expect(nextAdvice(limited, ['limit-five_hour'])).toBeNull()

    // The advice ends once the limit has reset: the dismissal is forgotten.
    expect(pruneDismissed(['limit-five_hour'], at(10))).toEqual([])
    // While it holds, the dismissal stands, and the very same array is handed back.
    const kept = ['limit-five_hour']
    expect(pruneDismissed(kept, limited)).toBe(kept)
  })
})

describe('facts', () => {
  test('a measurement keeps the last percent when the engine has none yet', () => {
    const before = at(60)
    const after = applyMeasure(before, { context: { window: 200_000 }, rateLimits: [], cost: { usd: 0.5 } })
    expect(after.contextPercent).toBe(60)
    expect(after.costUsd).toBe(0.5)
    expect(applyMeasure(before, { context: { window: 200_000, percent: 71, tokens: 142_000 }, rateLimits: [] }).contextPercent).toBe(71)
  })

  test('turns add up what they spent', () => {
    const turn = turnTokens({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000, model: 'm' })
    const once = applyTurn(initialFacts, turn, 1000, 0, 0)
    const twice = applyTurn(once, turn, 2000, 0, 0)
    // 100 + 100 uncached, 9,000 + 9,000 read, 50 + 50 out; no requests were counted for these.
    expect(twice.session).toEqual({ turns: 2, requestTurns: 0, requests: 0, input: 200, cacheWrite: 0, cacheRead: 18_000, output: 100 })
    expect(twice.turns).toBe(2)
    expect(twice.endedAt).toBe(2000)
  })

  test('after a compaction the window is what the summary left', () => {
    expect(applyCompacted(at(80), 50_000).contextPercent).toBe(25)
    expect(applyCompacted(at(80), undefined).contextPercent).toBe(80)
    expect(applyCompacted({ ...at(80), contextWindow: null }, 50_000).contextPercent).toBe(80)
  })

  test('a new prompt forgets last turn’s large output and notes a long pause, but only suspects the cache', () => {
    const minute = 60_000
    const f = at(40, { endedAt: 0, contextTokens: 80_000, bigOutput: { id: 'x', tool: 'Read', tokens: 20_000 } })
    const submit = (state: Facts, now: number) => applyPrompt(state, now, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens, 12)

    const soon = submit(f, 2 * minute)
    expect(soon.pausedContext).toBeNull()
    expect(soon.bigOutput).toBeNull()
    expect(submit(f, 6 * minute).pausedContext).toBe(80_000)
    // A small context is cheap to read again: no word about it.
    expect(submit({ ...f, contextTokens: 5000 }, 6 * minute).pausedContext).toBeNull()
    // No turn yet, no pause to speak of.
    expect(submit({ ...f, endedAt: null }, 60 * minute).pausedContext).toBeNull()
    // A suspicion is no advice yet.
    expect(ids(submit(f, 6 * minute))).toEqual([])
  })

  test('the turn after a pause says whether the cache really lapsed: it wrote the conversation back', () => {
    const paused = at(40, { pausedContext: 80_000, contextTokens: 80_000 })
    const turn = (cacheWrite: number, cacheRead: number) =>
      turnTokens({ input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, model: 'm' })

    // The cache held (a 1-hour cache, say): it read the context and wrote only the new part.
    const held = applyTurn(paused, turn(1500, 80_000), 10, 0, 0)
    expect(held.cacheLapse).toBeNull()
    expect(held.pausedContext).toBeNull()
    expect(ids(held)).toEqual([])

    // It lapsed: the whole conversation was written back.
    const lapsed = applyTurn(paused, turn(78_000, 0), 10, 0, 0)
    expect(lapsed.cacheLapse).toEqual({ tokens: 78_000 })
    expect(computeAdvice(lapsed)[0]?.title).toContain('78k')

    // No pause, no verdict, however much the turn wrote.
    expect(applyTurn(at(40), turn(78_000, 0), 10, 0, 0).cacheLapse).toBeNull()
  })

  test('only the largest output of a turn is kept', () => {
    const small = { id: 'a', tool: 'Read', tokens: 11_000 }
    const large = { id: 'b', tool: 'Bash', tokens: 30_000 }
    expect(applyBigOutput(applyBigOutput(initialFacts, small), large).bigOutput).toEqual(large)
    expect(applyBigOutput(applyBigOutput(initialFacts, large), small).bigOutput).toEqual(large)
  })

  test('/clear empties the conversation but keeps the money and the limits', () => {
    const f = at(80, { costUsd: 3, session: { ...noSession, turns: 4, output: 9000 }, turns: 4, rateLimits: [{ kind: 'five_hour', percentUsed: 50 }] })
    const cleared = applyCleared(f)
    expect(cleared.contextPercent).toBe(0)
    expect(cleared.session).toEqual(noSession)
    expect(cleared.turns).toBe(0)
    expect(cleared.costUsd).toBe(3)
    expect(cleared.rateLimits).toHaveLength(1)
  })
})

describe('heavy', () => {
  const breakdown = (categories: { name: string; tokens: number; kind: string }[]): SessionContextBreakdown =>
    ({ categories }) as unknown as SessionContextBreakdown

  test('lists the biggest in use, in plain words, leaving out free space', () => {
    const items = heavyFrom(
      breakdown([
        { name: 'Free space', tokens: 90_000, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        { name: 'Messages', tokens: 20_000, kind: 'used' },
        { name: 'MCP tools', tokens: 12_000, kind: 'used' },
        { name: 'System prompt', tokens: 3000, kind: 'used' },
        { name: 'Memory files', tokens: 2000, kind: 'used' },
        { name: 'Skills', tokens: 500, kind: 'used' },
      ]),
    )
    expect(items.map(i => i.name)).toEqual(['会話履歴', 'MCP のツール定義', 'システムプロンプト', 'CLAUDE.md などのメモリ', 'スキル一覧'])
    expect(items[1]?.hint).toContain('/mcp')
    expect(items[2]?.hint).toBeUndefined()
  })

  test('says so when the conversation itself is most of it', () => {
    const items = heavyFrom(
      breakdown([
        { name: 'Messages', tokens: 80_000, kind: 'used' },
        { name: 'System prompt', tokens: 5000, kind: 'used' },
      ]),
    )
    expect(items[0]?.hint).toContain('会話そのもの')
  })
})

describe('status', () => {
  test('API billing shows what is spent; a subscription shows its limits instead', () => {
    const api = statusRows(at(40, { costUsd: 2.5 })).map(r => r.label)
    expect(api).toContain('累計')
    expect(api).not.toContain('5時間の上限')

    const subscription = statusRows(at(40, { costUsd: 2.5, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }] })).map(r => r.label)
    expect(subscription).not.toContain('累計')
    expect(subscription).toContain('5時間の上限')
  })

  test('a fresh session says there is nothing yet, not zero', () => {
    const rows = statusRows(initialFacts)
    expect(rows.find(r => r.label === '今回')?.value).toBe('まだありません')
    expect(rows.find(r => r.label === 'コンテキスト')?.value).toBe('まだありません')
  })

  test('the last turn is shown as the API counted it, in full, so that it adds up and can be priced', () => {
    const turn = turnTokens({
      input_tokens: 8,
      output_tokens: 2_791,
      cache_creation_input_tokens: 3_705,
      cache_read_input_tokens: 668_265,
      model: 'claude-sonnet-5-5',
    })
    expect(promptTokens(turn)).toBe(671_978)
    const rows = statusRows({ ...at(40), last: turn })
    const row = (label: string) => rows.find(r => r.label === label)?.value
    expect(row('今回の入力')).toBe('671,978 tok ＝ キャッシュ読み 668,265 ＋ キャッシュ書き込み 3,705 ＋ キャッシュなし 8')
    expect(row('今回の出力')).toBe('2,791 tok（考えた分を含む）')
    expect(row('今回のモデル')).toBe('claude-sonnet-5-5')
    // The old sum, which left the cache reads out, is gone: nothing stands for the turn but these three.
    expect(rows.map(r => r.label)).not.toContain('今回')
  })

  test('the turn is shown as the sum of its requests: how many, what each sent, and the totals marked as sums', () => {
    const turn = turnTokens(
      { input_tokens: 4, output_tokens: 1_888, cache_creation_input_tokens: 2_206, cache_read_input_tokens: 382_666, model: 'claude-sonnet-5-5' },
      [191_785, 193_091],
    )
    const rows = statusRows({ ...at(40), last: turn })
    const row = (label: string) => rows.find(r => r.label === label)?.value
    expect(row('今回のリクエスト')).toBe('2 回（毎回、会話全体を送る。1回目 191,785 tok → 最後 193,091 tok）')
    expect(row('今回の入力')).toBe('384,876 tok（2 回の合計） ＝ キャッシュ読み 382,666 ＋ キャッシュ書き込み 2,206 ＋ キャッシュなし 4')
    expect(row('今回の出力')).toBe('1,888 tok（2 回の合計。考えた分を含む）')

    // One request: no "sum"; none counted (a reload in mid-turn): no request row.
    const one = statusRows({ ...at(40), last: { ...turn, prompts: [191_785] } })
    expect(one.find(r => r.label === '今回のリクエスト')?.value).toBe('1 回（会話全体 191,785 tok を送った）')
    expect(one.find(r => r.label === '今回の出力')?.value).toBe('1,888 tok（考えた分を含む）')
    expect(statusRows({ ...at(40), last: { ...turn, prompts: [] } }).map(r => r.label)).not.toContain('今回のリクエスト')
  })

  test('a turn kept from before the requests were counted still shows: no request row, no error', () => {
    // A reloaded mod keeps the session's state, and its last turn was made by the build before.
    const { prompts: _prompts, ...old } = turnTokens({ input_tokens: 8, output_tokens: 2_791, cache_creation_input_tokens: 3_705, cache_read_input_tokens: 668_265, model: 'm' })
    const rows = statusRows({ ...at(40), last: old as never })
    expect(rows.map(r => r.label)).not.toContain('今回のリクエスト')
    expect(rows.find(r => r.label === '今回の入力')?.value).toBe('671,978 tok ＝ キャッシュ読み 668,265 ＋ キャッシュ書き込み 3,705 ＋ キャッシュなし 8')
    expect(promptsOf(old as never)).toEqual([])
  })

  test('the session is shown in the same kinds as a turn: sums over every request of every turn', () => {
    const turn = (n: number, prompts: number[]) =>
      turnTokens({ input_tokens: 2 * n, output_tokens: 100 * n, cache_creation_input_tokens: 1_000 * n, cache_read_input_tokens: 50_000 * n, model: 'm' }, prompts)
    let f = applyTurn(initialFacts, turn(1, [51_000]), 1000, 0, 0)
    f = applyTurn(f, turn(2, [51_000, 52_000]), 2000, 0, 0)
    const rows = statusRows(f)
    const row = (label: string) => rows.find(r => r.label === label)?.value
    expect(row('このセッションの入力')).toBe('153,006 tok（2 ターン・リクエスト 3 回の合計） ＝ キャッシュ読み 150,000 ＋ キャッシュ書き込み 3,000 ＋ キャッシュなし 6')
    expect(row('このセッションの出力')).toBe('300 tok（考えた分を含む）')
    expect(rows.map(r => r.label)).not.toContain('このセッション')

    // Where a turn had no request counted, the count of requests is left out rather than short.
    const partial = applyTurn(f, turn(1, []), 3000, 0, 0)
    expect(statusRows(partial).find(r => r.label === 'このセッションの入力')?.value).toContain('（3 ターンの合計）')
  })

  test('a state kept from an older build has no session totals: its turns are said to be left out, and counting goes on', () => {
    const { session: _session, ...older } = { ...initialFacts, turns: 30 }
    const kept = older as unknown as Facts
    expect(sessionOf(kept)).toEqual(noSession)
    // Until a turn ends, it says so rather than "nothing yet".
    expect(statusRows(kept).find(r => r.label === 'このセッション')?.value).toBe('次のターンから数えます（これ以前の 30 ターンは含みません）')
    const next = applyTurn(kept, turnTokens({ input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, model: 'm' }, [1_102]), 1, 0, 0)
    expect(statusRows(next).find(r => r.label === 'このセッションの入力')?.value).toContain('（1 ターン・リクエスト 1 回の合計。これ以前の 30 ターンは含みません）')
  })

  test('every label of the status rows fits the label column of the pane, with room to spare', () => {
    const turn = turnTokens({ input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, model: 'm' }, [1_102])
    const f = applyTurn({ ...at(40), agentRuns: 1, agentTokens: 5_000, costUsd: null, rateLimits: [{ kind: 'seven_day', percentUsed: 9 }] }, turn, 1, 0, 0)
    const savings = { digests: 1, tokens: 1, milliUsd: 1, recovered: 0, forks: 1, keptTokens: 1, keptMilliUsd: 1, forkReaders: 0, forkRereads: 0, forkCostMilliUsd: 0, forkLosses: 0, subCuts: 1, subTokens: 1, flowReqs: 1, flowTokens: 1, flowKeptTokens: 1, flowMicroUsd: 1, wouldFire: 1 }
    const widest = Math.max(...statusRows(f, savings).map(r => cellWidth(r.label)))
    expect(widest).toBeLessThanOrEqual(LABEL_CELLS - 2)
  })

  test('counts are written in full, with separators', () => {
    expect([0, 8, 999, 1_000, 668_265, 4_934_632, 12_345_678].map(exactTokens)).toEqual(['0', '8', '999', '1,000', '668,265', '4,934,632', '12,345,678'])
  })

  test('the plain-text report says what to do, or that nothing is needed', () => {
    expect(report(at(30), [], [])).toContain('今は何もしなくて大丈夫です')
    const heavy = { facts: at(80), modes: initialModes, modelRow: null }
    const text = report(heavy.facts, computeAdvice(heavy.facts), computeOffers(heavy))
    expect(text).toContain('会話が重くなってきました')
    expect(text).toContain('受け入れると')
    expect(text).toContain('メモに残してから要約')
  })
})

describe('the gauge toward the auto-compaction', () => {
  const counting = (tokens: number, extra: Partial<Facts> = {}): Facts =>
    ({ ...at(Math.round(tokens / 2000)), contextTokens: tokens, autoCompactThreshold: 160_000, isAutoCompactEnabled: true, ...extra })

  test('the percent is the share of the size the engine compacts at, with both sizes beside it', () => {
    const fill = fillOf(counting(120_000))
    expect(fill).toEqual({ percent: 75, tokens: 120_000, limit: 160_000, isCompactAt: true })
    expect(fillTokens(fill)).toBe('120k/160k')
  })

  test('it is full only when the compaction is due: rounded down, and held at 100 beyond', () => {
    expect(fillOf(counting(159_999)).percent).toBe(99)
    expect(fillOf(counting(160_000)).percent).toBe(100)
    expect(fillOf(counting(175_000)).percent).toBe(100)
    expect(fillOf(counting(0)).percent).toBe(0)
  })

  test('with auto-compaction off, or its size not read yet, it is the window’s share, tokens against the window', () => {
    const off = fillOf(counting(120_000, { isAutoCompactEnabled: false }))
    expect(off).toEqual({ percent: 60, tokens: 120_000, limit: 200_000, isCompactAt: false })
    expect(fillTokens(off)).toBe('120k/200k')
    expect(fillOf(counting(120_000, { autoCompactThreshold: null })).isCompactAt).toBe(false)
    expect(fillOf(counting(120_000, { autoCompactThreshold: 0 })).isCompactAt).toBe(false)
  })

  test('without a token count there is only the percent; before anything is read it is nothing', () => {
    const fill = fillOf({ ...counting(120_000), contextTokens: null })
    expect(fill.percent).toBe(60)
    expect(fillTokens(fill)).toBeNull()
    expect(fillOf(initialFacts).percent).toBe(0)
  })

  test('a window of a million counts toward the size it compacts at, not the 200k the rest of the mod counts in', () => {
    const fill = fillOf({ ...initialFacts, contextTokens: 483_500, contextPercent: 48, contextWindow: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: true })
    expect(fill.percent).toBe(50)
    expect(fillTokens(fill)).toBe('484k/967k')
  })

  test('the pane says what is left before the compaction, or that there is none to wait for', () => {
    const row = (f: Facts): string | undefined => statusRows(f).find(r => r.label === 'コンテキスト')?.value
    expect(row(counting(120_000))).toContain('75%（いまの会話 120k tok / 自動要約の大きさ 160k tok。あと約 40k tok で自動要約）')
    expect(row(counting(175_000))).toContain('あと約 0 tok で自動要約')
    expect(row(counting(120_000, { isAutoCompactEnabled: false }))).toContain('60%（いまの会話 120k tok / 窓 200k tok。自動要約はオフ）')
    expect(row(counting(120_000, { isAutoCompactEnabled: null, autoCompactThreshold: null }))).toContain('60%（いまの会話 120k tok / 窓 200k tok）')
  })
})

describe('turns that something sent in set going', () => {
  const turn = { spent: 1_000, input: 100, cacheWrite: 0, cacheRead: 5_000, output: 900, model: 'm', prompts: [] }

  test('an agent’s hand-back or a schedule says nothing of how small the person’s requests are: the streak stays', () => {
    const base = { ...initialFacts, lightStreak: 2, promptChars: 10 }
    expect(applyTurn(base, turn, 1000, 0, 20, false).lightStreak).toBe(3)
    expect(applyTurn(base, turn, 1000, 0, 20, true).lightStreak).toBe(2)
    // A heavy turn of the person's breaks the streak; a heavy one sent in does not.
    expect(applyTurn(base, turn, 1000, 9, 5_000, false).lightStreak).toBe(0)
    expect(applyTurn(base, turn, 1000, 9, 5_000, true).lightStreak).toBe(2)
    // It is still a turn, and its tokens are the session's.
    expect(applyTurn(base, turn, 1000, 0, 20, true).turns).toBe(1)
    expect(applyTurn(base, turn, 1000, 0, 20, true).session.turns).toBe(1)
  })

  test('the pause before it still counts toward a lapsed cache; nothing else of the person’s prompt is touched', () => {
    const base = {
      ...initialFacts,
      endedAt: 0,
      contextTokens: 60_000,
      promptChars: 77,
      bigOutput: { id: 'x', tool: 'Read', tokens: 15_000 },
      agentTokensThisTurn: 4_000,
    }
    const later = applySentIn(base, 10 * 60_000, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens)
    expect(later.pausedContext).toBe(60_000)
    expect(later.promptChars).toBe(77)
    expect(later.bigOutput).not.toBeNull()
    expect(later.agentTokensThisTurn).toBe(4_000)
    expect(applySentIn(base, 60_000, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens).pausedContext).toBeNull()
  })
})

describe('mascot', () => {
  test('every face is made of narrow characters only, and fits the room kept for it', () => {
    // ASCII and the halfwidth marks (ｪ ･). `•` and `ω` are ambiguous-width: two cells in a terminal set for Japanese.
    for (const face of Object.values(FACE)) {
      expect(face).toMatch(/^[\x20-\x7e\uff61-\uff9f]+$/)
      expect(face.length).toBeLessThanOrEqual(FACE_CELLS)
    }
  })

  test('it feels the worse of the context and the advice on show, and is busy while it works', () => {
    expect(moodOf(at(30), null, false)).toBe('good')
    expect(moodOf(at(75), null, false)).toBe('heavy')
    expect(moodOf(at(95), null, false)).toBe('full')
    // A quiet conversation with an alarming limit: the advice decides.
    const limited = at(10, { rateLimits: [{ kind: 'five_hour', percentUsed: 97 }] })
    expect(moodOf(limited, computeAdvice(limited)[0] ?? null, false)).toBe('full')
    // The same limit put off: nothing on show, and the context is fine.
    expect(moodOf(limited, null, false)).toBe('good')
    expect(moodOf(at(95), null, true)).toBe('busy')
  })

  test('the plain-text report opens with the face that matches', () => {
    expect(report(at(30), [], []).startsWith(FACE.good)).toBe(true)
    const heavy = { facts: at(95), modes: initialModes, modelRow: null }
    expect(report(heavy.facts, computeAdvice(heavy.facts), computeOffers(heavy)).startsWith(FACE.full)).toBe(true)
  })
})

describe('modes', () => {
  test('a cap lowers the effort and never raises it', () => {
    expect(cappedEffort('xhigh', 'medium')).toBe('medium')
    expect(cappedEffort('max', 'low')).toBe('low')
    expect(cappedEffort('high', 'low')).toBe('low')
    // Already at or below the cap: left alone.
    expect(cappedEffort('low', 'medium')).toBeUndefined()
    expect(cappedEffort('medium', 'medium')).toBeUndefined()
    expect(cappedEffort('low', 'low')).toBeUndefined()
  })

  test('with no cap, no effort on the model, or a token budget, the step goes out as it was', () => {
    expect(cappedEffort('xhigh', null)).toBeUndefined()
    expect(cappedEffort(undefined, 'low')).toBeUndefined()
    expect(cappedEffort(8000, 'low')).toBeUndefined()
    expect(cappedEffort('some-future-level', 'low')).toBeUndefined()
  })

  test('only cheaper models are offered, and only those the row allows', () => {
    const all = ['default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]']
    expect(lighterModels('opus', all)).toEqual(['sonnet', 'haiku'])
    expect(lighterModels('default', all)).toEqual(['sonnet', 'haiku'])
    expect(lighterModels('sonnet', all)).toEqual(['haiku'])
    expect(lighterModels('sonnet[1m]', all)).toEqual(['haiku'])
    expect(lighterModels('haiku', all)).toEqual([])
    expect(lighterModels('opus', ['default', 'opus'])).toEqual([])
  })

  test('a conversation that outgrew a 200k window is not moved onto a 200k model; nothing else is refused', () => {
    expect(fitsWindow('sonnet', 100_000, 1_000_000)).toBe(true)
    expect(fitsWindow('sonnet', 170_000, 1_000_000)).toBe(false)
    expect(fitsWindow('sonnet[1m]', 400_000, 1_000_000)).toBe(true)
    // Between two 200k windows the engine already keeps the context inside: no reason to refuse.
    expect(fitsWindow('sonnet', 170_000, 200_000)).toBe(true)
    expect(fitsWindow('sonnet', 170_000, null)).toBe(true)
    expect(fitsWindow('sonnet', null, 1_000_000)).toBe(true)
  })

  test('the band is told only about what changes how Claude works', () => {
    expect(tagOf(initialModes)).toBeNull()
    expect(tagOf({ ...initialModes, isHandoffOn: true })).toBeNull()
    expect(tagOf({ ...initialModes, effort: 'low' })).toBe('節約中: effort 低め')
    expect(tagOf({ ...initialModes, effort: 'medium', isWorkerOn: true })).toBe('節約中: effort ふつう・軽量エージェント')
  })
})

describe('handoff', () => {
  const call = (tool: string, input: Record<string, unknown>, id: string) => ({ tool_use_id: id, tool, input })
  const user = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role: 'user', text, toolUses })
  const assistant = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role: 'assistant', text, toolUses })

  const transcript: SessionMessage[] = [
    user('Add a dark mode toggle to settings'),
    assistant('', [call('Read', { file_path: '/repo/src/settings.tsx' }, 'a'), call('Read', { file_path: '/repo/src/theme.ts' }, 'b')]),
    assistant('', [call('Edit', { file_path: '/repo/src/theme.ts' }, 'c'), call('Write', { file_path: '/repo/src/toggle.tsx' }, 'd')]),
    assistant('', [call('Bash', { command: 'bun test\necho done' }, 'e')]),
    user('Also persist it across restarts'),
    assistant('Done: the toggle persists in localStorage.'),
  ]

  test('the note keeps the requests, the files touched, the commands and the last answer', () => {
    const note = buildHandoff(transcript, '2026-10-09T15:00:00.000Z')
    expect(note).toContain('Saved 2026-10-09T15:00:00.000Z')
    expect(note).toContain('- Add a dark mode toggle to settings')
    expect(note).toContain('- Also persist it across restarts')
    expect(note).toContain('## Files edited or written')
    expect(note).toContain('- /repo/src/theme.ts')
    expect(note).toContain('- /repo/src/toggle.tsx')
    expect(note).toContain('- bun test')
    expect(note).not.toContain('echo done')
    expect(note).toContain('Done: the toggle persists in localStorage.')
  })

  test('a file that was edited is not listed again as merely read', () => {
    const note = buildHandoff(transcript, 'now')
    const readSection = note.split('## Files read')[1]?.split('##')[0] ?? ''
    expect(readSection).toContain('/repo/src/settings.tsx')
    expect(readSection).not.toContain('/repo/src/theme.ts')
  })

  test('notices, command echoes and a carried-over summary are not listed as the person\'s requests', () => {
    const note = buildHandoff(
      [
        user('Fix the login redirect'),
        user('<task-notification>\n<task-id>a1</task-id>\n<status>stopped</status>\n</task-notification>'),
        user('<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>'),
        user('<command-name>/model</command-name>\n<command-message>model</command-message>'),
        user('[Request interrupted by user]'),
        user('[Image: original 962x2008, displayed at 958x2000.]'),
        user('This session is being continued from a previous conversation that ran out of context. The summary below…'),
        user('<div> is not closed on the login page'),
        assistant('Looking.'),
      ],
      'now',
    )
    const requests = note.split('## Recent requests (oldest first)')[1]?.split('##')[0] ?? ''
    expect(requests).toContain('- Fix the login redirect')
    expect(requests).toContain('- <div> is not closed on the login page')
    expect(requests).not.toContain('task-notification')
    expect(requests).not.toContain('local-command')
    expect(requests).not.toContain('command-name')
    expect(requests).not.toContain('interrupted')
    expect(requests).not.toContain('[Image:')
    expect(requests).not.toContain('This session is being continued')
  })

  test('scratch files in temp folders get a short section of their own and do not crowd out the work', () => {
    const scratchTools = Array.from({ length: 15 }, (_, i) => call('Write', { file_path: `/private/tmp/claude-501/x/scratchpad/probe${i}.ts` }, `s${i}`))
    const note = buildHandoff(
      [
        user('Probe the engine'),
        assistant('', [call('Edit', { file_path: '/repo/src/real.ts' }, 'r1'), call('Read', { file_path: '/repo/src/other.ts' }, 'r2')]),
        assistant('', scratchTools),
        assistant('', [call('Read', { file_path: '/var/folders/2x/abc/T/claude-tokenomics/s/out-t1.log' }, 'r3')]),
      ],
      'now',
    )
    const part = (title: string): string => note.split(`## ${title}`)[1]?.split('##')[0] ?? ''
    expect(part('Files edited or written')).toContain('- /repo/src/real.ts')
    expect(part('Files edited or written')).not.toContain('/tmp/')
    expect(part('Files read')).toContain('- /repo/src/other.ts')
    expect(part('Files read')).not.toContain('/var/folders/')
    const scratch = note.split('## Scratch files in temp folders')[1]?.split('\n\n')[0] ?? ''
    expect(scratch.match(/^- /gm)?.length).toBe(10)
    // The latest ones are kept, whether written or read.
    expect(scratch).toContain('out-t1.log')
    expect(scratch).toContain('probe14.ts')
    expect(scratch).not.toContain('probe0.ts')
  })

  test('a note with no scratch files has no scratch section', () => {
    expect(buildHandoff(transcript, 'now')).not.toContain('Scratch files')
  })

  test('an empty transcript makes a note with no empty sections', () => {
    const note = buildHandoff([], 'now')
    expect(note).toContain('# Work notes saved before compaction')
    expect(note).not.toContain('## ')
  })

  test('a long transcript is cut to a few thousand tokens', () => {
    const many = Array.from({ length: 200 }, (_, i) => user(`request number ${i} ${'x'.repeat(380)}`))
    const note = buildHandoff(many, 'now')
    expect(note.length).toBeLessThanOrEqual(12_000)
    // The newest requests are the ones kept.
    expect(note).toContain('request number 199')
    expect(note).not.toContain('request number 100 ')
  })

  test('where the note goes, and how the summary is asked to point at it', () => {
    expect(handoffDir('/var/tmp/', 's1')).toBe('/var/tmp/claude-tokenomics/s1')
    expect(handoffDir(undefined, 's1')).toBe('/tmp/claude-tokenomics/s1')
    expect(handoffDir('', 's1')).toBe('/tmp/claude-tokenomics/s1')
    expect(handoffPath('/d', 2)).toBe('/d/handoff-2.md')
    expect(handoffPath('/d', 'pre')).toBe('/d/handoff-pre.md')

    const asked = withPointer(undefined, '/d/handoff-1.md')
    expect(asked).toContain('Details: /d/handoff-1.md')
    const kept = withPointer('focus on the plan', '/d/handoff-1.md')
    expect(kept.startsWith('focus on the plan\n')).toBe(true)
    expect(kept).toContain('/d/handoff-1.md')
  })
})

const ctx = (f: Facts, over: { modes?: Partial<Modes>; modelRow?: ModelRow | null } = {}) => ({
  facts: f,
  modes: { ...initialModes, ...over.modes },
  modelRow: over.modelRow === undefined ? null : over.modelRow,
})

const opus: ModelRow = { value: 'opus', options: ['default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]'] }
const kinds = (c: ReturnType<typeof ctx>): string[] => computeOffers(c).map(o => o.id)
/** Three small turns in a row, on a model that thinks hard. */
const light = { lightStreak: 3, stepEffort: 'xhigh' }

describe('offers', () => {
  test('nothing is proposed while there is nothing to save', () => {
    expect(kinds(ctx(initialFacts))).toEqual([])
    expect(kinds(ctx(at(52)))).toEqual([])
    expect(kinds(ctx(at(69), { modelRow: opus }))).toEqual([])
  })

  test('a heavy conversation is proposed at 70 and again, more urgently, at 90', () => {
    expect(kinds(ctx(at(70)))).toEqual(['compact-70'])
    expect(kinds(ctx(at(89)))).toEqual(['compact-70'])
    expect(kinds(ctx(at(90)))).toEqual(['compact-90'])
    const full = computeOffers(ctx(at(95)))[0]
    expect(full?.level).toBe('warn')
    expect(full?.accept).toBe('要約する')
  })

  test('the compaction offer says that a note is left, and does not repeat itself once notes are on', () => {
    expect(computeOffers(ctx(at(75)))[0]?.does).toContain('メモに残してから要約')
    expect(computeOffers(ctx(at(75), { modes: { isHandoffOn: true } }))[0]?.does).not.toContain('以降の要約でも')
  })

  test('autocompact is proposed only when it is off, may be set, and the conversation is getting heavy', () => {
    const off = { isAutoCompactEnabled: false, canSetAutoCompact: true }
    expect(kinds(ctx(at(75, off)))).toEqual(['compact-70', 'autocompact'])
    expect(kinds(ctx(at(40, off)))).toEqual([])
    expect(kinds(ctx(at(75, { ...off, canSetAutoCompact: false })))).toEqual(['compact-70'])
    expect(kinds(ctx(at(75, { isAutoCompactEnabled: true, canSetAutoCompact: true })))).toEqual(['compact-70'])
  })

  test('a commit or a change of folder is a natural break, if there is something to lose', () => {
    expect(kinds(ctx(at(30, { boundary: 'commit', conversationTokens: 40_000 })))).toEqual(['boundary'])
    expect(computeOffers(ctx(at(30, { boundary: 'cwd', conversationTokens: 40_000 })))[0]?.title).toContain('作業フォルダ')
    // A small conversation is not worth a word, however much the window holds before the first one.
    expect(kinds(ctx(at(30, { boundary: 'commit', conversationTokens: 5_000 })))).toEqual([])
    // Nor one whose size is not known yet.
    expect(kinds(ctx(at(30, { boundary: 'commit' })))).toEqual([])
  })

  test('a large read, of a command output or anything else, proposes the helper, until it is on', () => {
    const big = (tool: string) => at(10, { bigOutput: { id: 'x', tool, tokens: 14_000 } })
    expect(kinds(ctx(big('Bash')))).toEqual(['worker'])
    expect(kinds(ctx(big('Read')))).toEqual(['worker'])
    expect(kinds(ctx(big('Bash'), { modes: { isWorkerOn: true } }))).toEqual([])
  })

  test('a lighter model is proposed only while the conversation is small, and when it would help', () => {
    // The window holds a good deal before the first word, so the conversation's own size is what counts.
    const small = { contextTokens: 30_000, conversationTokens: 3_000, contextPercent: 15, contextWindow: 200_000 }
    const offered = computeOffers(ctx(at(15, { ...small, lightStreak: 3 }), { modelRow: opus }))[0]
    expect(offered?.id).toBe('model')
    expect(offered?.target).toBe('sonnet')
    expect(offered?.accept).toBe('Sonnet にする')
    expect(offered?.does).toContain('終了するときに、元のモデルへ戻します')
    // It says what the person pays: the whole window read again, not only the conversation.
    expect(offered?.why).toContain('約3k tok')
    expect(offered?.why).toContain('約30k tok')
    // Or a limit running out.
    const limited = at(15, { ...small, rateLimits: [{ kind: 'five_hour', percentUsed: 72 }] })
    expect(computeOffers(ctx(limited, { modelRow: opus }))[0]?.title).toContain('5時間の上限')
    // Neither: nothing to gain yet.
    expect(kinds(ctx(at(15, small), { modelRow: opus }))).toEqual([])
    // A big conversation would be read again in full; one not yet measured is not guessed at.
    expect(kinds(ctx(at(40, { ...small, conversationTokens: 60_000, lightStreak: 3 }), { modelRow: opus }))).toEqual([])
    expect(kinds(ctx(at(15, { ...small, conversationTokens: null, lightStreak: 3 }), { modelRow: opus }))).toEqual([])
    // Already moved, or nothing lighter, or the row unread.
    expect(kinds(ctx(at(15, { ...small, lightStreak: 3 }), { modelRow: opus, modes: { previousModel: 'opus' } }))).toEqual([])
    expect(kinds(ctx(at(15, { ...small, lightStreak: 3 }), { modelRow: { ...opus, value: 'haiku' } }))).toEqual([])
    expect(kinds(ctx(at(15, { ...small, lightStreak: 3 })))).toEqual([])
  })

  test('a lighter model goes one step down, not two', () => {
    const small = { contextTokens: 30_000, conversationTokens: 3_000, lightStreak: 3, contextPercent: 15, contextWindow: 200_000 }
    const sonnet: ModelRow = { value: 'sonnet', options: opus.options }
    expect(computeOffers(ctx(at(15, small), { modelRow: sonnet }))[0]?.target).toBe('haiku')
  })

  test('"default" names no model: the model that answered says which tier it is', () => {
    const small = { contextTokens: 30_000, conversationTokens: 3_000, lightStreak: 3, contextPercent: 15, contextWindow: 200_000 }
    const row: ModelRow = { value: 'default', options: opus.options }
    const answered = (model: string) => ({ spent: 1, input: 1, cacheWrite: 0, cacheRead: 0, output: 1, model, prompts: [] })
    // The default has turned out to be Opus: both lighter ones are open.
    expect(computeOffers(ctx(at(15, { ...small, last: answered('claude-opus-5-5') }), { modelRow: row }))[0]?.target).toBe('sonnet')
    // The default is already Sonnet: only Haiku is lighter.
    expect(computeOffers(ctx(at(15, { ...small, last: answered('claude-sonnet-5-5') }), { modelRow: row }))[0]?.target).toBe('haiku')
  })

  test('a lower effort is proposed after small turns on a model that thinks hard, once', () => {
    expect(kinds(ctx(at(30, light)))).toEqual(['effort'])
    for (const effort of ['high', 'xhigh', 'max']) expect(kinds(ctx(at(30, { ...light, stepEffort: effort })))).toEqual(['effort'])
    expect(kinds(ctx(at(30, { ...light, stepEffort: 'medium' })))).toEqual([])
    expect(kinds(ctx(at(30, { ...light, stepEffort: null })))).toEqual([])
    expect(kinds(ctx(at(30, { ...light, lightStreak: 2 })))).toEqual([])
    expect(kinds(ctx(at(30, light), { modes: { effort: 'medium' } }))).toEqual([])
    expect(computeOffers(ctx(at(30, light)))[0]?.does).toContain('公式ドキュメント')
  })

  test('prompt suggestions are mentioned after a few turns, only if on and settable', () => {
    expect(kinds(ctx(at(30, { isSuggestEnabled: true, turns: 5 })))).toEqual(['suggest'])
    expect(kinds(ctx(at(30, { isSuggestEnabled: true, turns: 4 })))).toEqual([])
    expect(kinds(ctx(at(30, { isSuggestEnabled: false, turns: 9 })))).toEqual([])
    expect(kinds(ctx(at(30, { isSuggestEnabled: null, turns: 9 })))).toEqual([])
  })

  test('the most urgent is put first, whatever else fits', () => {
    const f = at(92, { ...light, boundary: 'commit', conversationTokens: 50_000, isAutoCompactEnabled: false, canSetAutoCompact: true, bigOutput: { id: 'x', tool: 'Bash', tokens: 20_000 }, isSuggestEnabled: true, turns: 8 })
    expect(kinds(ctx(f))).toEqual(['compact-90', 'boundary', 'autocompact', 'worker', 'effort', 'suggest'])
  })

  test('the next one is the most urgent not yet made and not muted', () => {
    const f = ctx(at(75, { isAutoCompactEnabled: false, canSetAutoCompact: true }))
    expect(nextOffer(f, [], [])?.id).toBe('compact-70')
    expect(nextOffer(f, ['compact-70'], [])?.id).toBe('autocompact')
    expect(nextOffer(f, ['compact-70'], ['autocompact'])).toBeNull()
    expect(nextOffer(f, [], ['compact'])?.id).toBe('autocompact')
  })

  test('the pane keeps what is muted off the table, and what was put off on it', () => {
    const f = ctx(at(75, { isAutoCompactEnabled: false, canSetAutoCompact: true }))
    expect(standingOffers(f, []).map(o => o.id)).toEqual(['compact-70', 'autocompact'])
    expect(standingOffers(f, ['compact']).map(o => o.id)).toEqual(['autocompact'])
  })

  test('a heavy spell that has ended is forgotten, so the next one is offered anew; a once-a-session offer is not', () => {
    const seen = ['compact-70', 'worker', 'effort']
    expect(pruneSeen(seen, at(80))).toBe(seen)
    expect(pruneSeen(seen, at(40))).toEqual(['worker', 'effort'])
    // Past 90 the 70 spell goes on; falling back to 80 ends only the 90 one.
    expect(pruneSeen(['compact-70', 'compact-90'], at(95))).toEqual(['compact-70', 'compact-90'])
    expect(pruneSeen(['compact-70', 'compact-90'], at(80))).toEqual(['compact-70'])
  })

  test('every kind has a name for the pane to list when it is muted', () => {
    const everyKind: OfferKind[] = ['compact', 'autocompact', 'boundary', 'worker', 'model', 'effort', 'suggest']
    for (const kind of everyKind) expect(OFFER_NAMES[kind]).toBeDefined()
  })

  test('small turns are counted and a big one starts the count again', () => {
    const turn = (output: number) =>
      turnTokens({ input_tokens: 100, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'm' })
    const prompted = (f: Facts, chars: number) => applyPrompt(f, 0, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens, chars)
    let f: Facts = initialFacts
    for (let i = 0; i < 3; i += 1) f = applyTurn(prompted(f, 20), turn(200), i, 0, 100)
    expect(f.lightStreak).toBe(3)
    // A long prompt, a long answer on screen, or many tool calls: not a small turn.
    expect(applyTurn(prompted(f, 400), turn(200), 9, 0, 100).lightStreak).toBe(0)
    expect(applyTurn(prompted(f, 20), turn(200), 9, 0, 900).lightStreak).toBe(0)
    expect(applyTurn(prompted(f, 20), turn(200), 9, 4, 100).lightStreak).toBe(0)
    expect(applyTurn(prompted(f, 20), turn(200), 9, 1, 100).lightStreak).toBe(4)
  })

  test('a turn is small by what is shown, not by output tokens: thinking is billed as output and cannot be turned off', () => {
    const thoughtful = turnTokens({ input_tokens: 100, output_tokens: 4_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, model: 'm' })
    const prompted = applyPrompt(initialFacts, 0, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens, 20)
    expect(applyTurn(prompted, thoughtful, 1, 0, 40).lightStreak).toBe(1)
  })

  test('a boundary and the effort asked for are noted, and the next prompt forgets the boundary', () => {
    expect(applyBoundary(initialFacts, 'commit').boundary).toBe('commit')
    expect(applyPrompt(applyBoundary(initialFacts, 'cwd'), 0, 1, 1, 5).boundary).toBeNull()
    const stepped = applyStep(initialFacts, 'xhigh')
    expect(stepped.stepEffort).toBe('xhigh')
    // The same value again is the same facts: nothing is written for it.
    expect(applyStep(stepped, 'xhigh')).toBe(stepped)
    expect(applyStep(stepped, 8000).stepEffort).toBeNull()
    expect(applyStep(stepped, undefined).stepEffort).toBeNull()
  })
})

describe('what was accepted', () => {
  test('is listed with the words that end it, and is empty at the start', () => {
    expect(activeSavings(initialModes)).toEqual([])
    const all = activeSavings({ ...initialModes, effort: 'low', isWorkerOn: true, isHandoffOn: true, previousModel: 'opus' })
    expect(all.map(a => a.key)).toEqual(['effort', 'worker', 'handoff', 'model'])
    // Where the note is on by default it is not an accepted saving to end.
    expect(activeSavings({ ...initialModes, isHandoffOn: true }, true)).toEqual([])
    expect(all.find(a => a.key === 'model')?.stop).toBe('元に戻す')
    expect(all.find(a => a.key === 'effort')?.label).toContain('低め')
  })
})

describe('boundary commands', () => {
  test('a commit or a pull request ends a piece of work', () => {
    for (const command of ['git commit -m "x"', 'git add . && git commit -am wip', 'git -C /repo commit -m x', 'gh pr create --fill', 'gh pr merge 12']) {
      expect(isBoundaryCommand(command)).toBe(true)
    }
  })

  test('other commands do not', () => {
    for (const command of ['git status', 'git log --grep commit', 'git push', 'ls commit', 'gh pr view 12', undefined, 42]) {
      expect(isBoundaryCommand(command)).toBe(false)
    }
  })
})

describe('a note that is worth reading after a /clear', () => {
  const call = (tool: string, input: Record<string, unknown>, id: string, isError?: true) => ({ tool_use_id: id, tool, input, ...(isError === undefined ? {} : { isError }) })
  const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
  const assistant = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role: 'assistant', text, toolUses })
  const bash = (command: string, id: string, isError?: true) => assistant('', [call('Bash', { command }, id, isError)])
  const part = (note: string, title: string): string => note.split(`## ${title}`)[1]?.split('\n## ')[0] ?? ''

  test('it says what it was written for', () => {
    expect(buildHandoff([user('a')], 'now', 'clear')).toContain('# Work notes saved before /clear')
    expect(buildHandoff([user('a')], 'now', 'fresh')).toContain('# Work notes saved before a fresh start')
    expect(buildHandoff([user('a')], 'now')).toContain('# Work notes saved before compaction')
  })

  test('commands that only look are left out; what ran, and what failed, is kept', () => {
    const note = buildHandoff(
      [
        user('Fix it'),
        bash('cd ../.. && grep -rn "x" src | head -20', 'a'),
        bash("sed -n 60,108p hooks/ui/band.tsx; sed -n 1,5p README.md", 'b'),
        bash('ls -la && cat package.json', 'c'),
        bash('git status --short && git log --oneline -3', 'd'),
        bash('grep -c x file 2>&1 | head -1', 'e'),
        bash('bun test', 'f', true),
        bash("sed -i '' 's/a/b/' src/a.ts", 'g'),
        bash('git commit -m "Fix it"', 'h'),
        bash("python3 - <<'EOF'\nopen('x','w').write('1')\nEOF", 'i'),
        bash('echo hi > out.txt', 'j'),
        bash('cd repo\nrm -rf build', 'k'),
        assistant('Done.'),
      ],
      'now',
    )
    const commands = part(note, 'Commands run, reads and searches left out (latest 20)')
    for (const looked of ['grep -rn', 'sed -n', 'ls -la', 'git status', 'git log', 'grep -c']) expect(commands).not.toContain(looked)
    expect(commands).toContain('- bun test (failed)')
    expect(commands).toContain("- sed -i '' 's/a/b/' src/a.ts")
    expect(commands).toContain('- git commit -m "Fix it"')
    expect(commands).toContain("- python3 - <<'EOF'")
    expect(commands).toContain('- echo hi > out.txt')
    // The line that did something, not the `cd` before it.
    expect(commands).toContain('- rm -rf build')
    expect(commands).not.toContain('- cd repo')
  })

  test('the same command run again and again is listed once in a row', () => {
    const note = buildHandoff([user('x'), bash('bun test', 'a'), bash('bun test', 'b'), bash('bun build', 'c'), bash('bun test', 'd')], 'now')
    expect(part(note, 'Commands run, reads and searches left out (latest 20)').match(/^- bun /gm)?.length).toBe(3)
  })

  test('with many requests the first one is kept apart, because it says what the work is', () => {
    const many = [user('Build the savings display'), ...Array.from({ length: 12 }, (_, i) => user(`follow-up ${i}`))]
    const note = buildHandoff(many, 'now')
    expect(part(note, 'First request')).toContain('Build the savings display')
    expect(part(note, 'Recent requests (oldest first)')).not.toContain('Build the savings display')
    expect(part(note, 'Recent requests (oldest first)')).toContain('follow-up 11')
    // With few requests there is nothing to keep apart.
    expect(buildHandoff(many.slice(0, 4), 'now')).not.toContain('## First request')
  })

  test('a summary carried over from an earlier compaction gives its head, without the lead-in sentence', () => {
    const carried = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\nSummary:\n1. Primary Request and Intent:\n   - Make savings visible to users\n2. Key Technical Concepts: ${'y'.repeat(3000)}`
    const note = buildHandoff([user(carried), assistant('Continuing.')], 'now', 'clear')
    const head = part(note, 'Carried-over summary of the earlier conversation (its head)')
    expect(head).toContain('Primary Request and Intent')
    expect(head).toContain('Make savings visible to users')
    expect(head).not.toContain('ran out of context')
    expect(head.length).toBeLessThan(1_700)
    // It is the earlier conversation's, not a request of the person's.
    expect(note).not.toContain('## Recent requests')
  })

  test('the last answer comes before the lists, so a note over the limit loses the lists first', () => {
    const reads = Array.from({ length: 40 }, (_, i) => call('Read', { file_path: `/repo/${'d'.repeat(300)}/f${i}.ts` }, `r${i}`))
    const note = buildHandoff([user('Go'), assistant('', reads), assistant(`Next step: ship it. ${'z'.repeat(2400)}`)], 'now')
    expect(note.length).toBeLessThanOrEqual(12_000)
    expect(note).toContain('Next step: ship it.')
    expect(note.indexOf('## Last answer')).toBeLessThan(note.indexOf('## Files read'))
  })

  test('a conversation has work to note when the person asked and was answered', () => {
    expect(hasWork([])).toBe(false)
    expect(hasWork([user('hi')])).toBe(false)
    expect(hasWork([assistant('hello')])).toBe(false)
    expect(hasWork([user('<local-command-stdout>x</local-command-stdout>'), assistant('hello')])).toBe(false)
    expect(hasWork([user('Fix the login redirect'), assistant('Looking.')])).toBe(true)
    // A long task after an auto-compaction: the only user turn is the carried-over summary, and it is the work.
    expect(hasWork([user('This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Goal'), assistant('Continuing.')])).toBe(true)
    expect(hasWork([user('This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Goal')])).toBe(false)
  })

  test('find looks unless it is told to delete, run something or write; the rest of a line that does something is kept', () => {
    const note = buildHandoff(
      [user('x'), bash('find . -name "*.ts" -type f', 'a'), bash('find build -name "*.o" -delete', 'b'), bash("find . -name x -exec rm {} \\;", 'c'), assistant('ok')],
      'now',
    )
    const commands = part(note, 'Commands run, reads and searches left out (latest 20)')
    expect(commands).not.toContain('-type f')
    expect(commands).toContain('-delete')
    expect(commands).toContain('-exec rm')
  })

  test('the git state is read as the branch and what changed, and put ahead of the lists', () => {
    const lines = formatGit('## main...origin/main [ahead 2]\n M src/a.ts\n?? notes.md\n')
    expect(lines).toEqual(['branch: main...origin/main [ahead 2]', ' M src/a.ts', '?? notes.md'])
    const note = withGit(buildHandoff([user('Go'), assistant('Done.', [call('Edit', { file_path: '/repo/a.ts' }, 'e')])], 'now'), lines)
    expect(note).toContain('## Git state when saved')
    expect(note.indexOf('## Last answer')).toBeLessThan(note.indexOf('## Git state'))
    expect(note.indexOf('## Git state')).toBeLessThan(note.indexOf('## Files edited or written'))
    expect(note).toContain('branch: main...origin/main [ahead 2]')
  })

  test('a long change list is cut, a note with no lists takes the git state at its end, and no git state changes nothing', () => {
    const many = formatGit(`## main\n${Array.from({ length: 80 }, (_, i) => ` M f${i}.ts`).join('\n')}`)
    expect(many.length).toBe(41)
    expect(many.at(-1)).toBe('… and 41 more')
    const bare = buildHandoff([user('Go')], 'now')
    expect(withGit(bare, ['branch: main']).trimEnd().endsWith('branch: main')).toBe(true)
    expect(withGit(bare, [])).toBe(bare)
  })

  test('the line for the next conversation names the file and asks to read it only for the earlier work', () => {
    const line = clearPointer('/t/claude-tokenomics/s/handoff-5.md')
    expect(line).toContain('/t/claude-tokenomics/s/handoff-5.md')
    expect(line).toContain('only if the person asks you to carry on')
    expect(line.split('\n').length).toBe(1)
  })
})
