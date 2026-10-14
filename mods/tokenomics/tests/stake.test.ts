import { describe, expect, test } from 'claude-code/testing'

import { initialFacts } from '../hooks/lib/facts'
import { statusRows } from '../hooks/lib/status'
import { FALLBACK_BASELINE_TOKENS, SUMMARY_TOKENS, stakeOf, stakeText } from '../hooks/lib/stake'

import { SURFACES, bandProps, engine, measure, paneProps } from './kit'

const turn = (model: string) => ({ spent: 1, input: 1, cacheWrite: 0, cacheRead: 1, output: 1, model, prompts: [1] })

const facts = (over: Partial<typeof initialFacts>) => ({ ...initialFacts, ...over })

describe('what carrying the conversation costs on every request', () => {
  test('nothing is said before the conversation has been measured', () => {
    expect(stakeOf(initialFacts)).toBeNull()
    expect(stakeOf(facts({ contextTokens: 0 }))).toBeNull()
  })

  test('the size now against what a summary leaves: the start of the conversation plus a summary', () => {
    const s = stakeOf(facts({ contextTokens: 420_000, baselineTokens: 30_000 }))
    expect(s).toMatchObject({ tokens: 420_000, afterTokens: 30_000 + SUMMARY_TOKENS, isWorthSaying: true })
    expect(Math.abs((s?.times ?? 0) - 10)).toBeLessThan(1e-9)
    // The start of the conversation not measured yet: a stand-in.
    expect(stakeOf(facts({ contextTokens: 420_000 }))?.afterTokens).toBe(FALLBACK_BASELINE_TOKENS + SUMMARY_TOKENS)
  })

  test('off a subscription the reading is priced at list prices, a request at a time; on one there are no dollars', () => {
    const api = stakeOf(facts({ contextTokens: 420_000, baselineTokens: 28_000, last: turn('claude-sonnet-5-5') }))
    // 420,000 tokens read at $0.1 a million.
    expect(Math.abs((api?.usd ?? 0) - 0.042)).toBeLessThan(1e-9)
    expect(Math.abs((api?.afterUsd ?? 0) - 0.004)).toBeLessThan(1e-9)
    const subscription = stakeOf(facts({ contextTokens: 420_000, last: turn('claude-sonnet-5-5'), rateLimits: [{ kind: 'five_hour', percentUsed: 30 }] }))
    expect(subscription?.usd).toBeNull()
    expect(subscription?.afterUsd).toBeNull()
    // A model not in the list has no price either.
    expect(stakeOf(facts({ contextTokens: 420_000, last: turn('mystery') }))?.usd).toBeNull()
  })

  test('a summary is only worth saying once it would halve the conversation at least', () => {
    expect(stakeOf(facts({ contextTokens: 79_000, baselineTokens: 28_000 }))?.isWorthSaying).toBe(false)
    expect(stakeOf(facts({ contextTokens: 80_000, baselineTokens: 28_000 }))?.isWorthSaying).toBe(true)
  })

  test('the words: tokens, dollars where they apply, and how much smaller a summary would make it', () => {
    const big = stakeOf(facts({ contextTokens: 420_000, baselineTokens: 28_000, last: turn('claude-sonnet-5-5') }))
    expect(stakeText(big!)).toBe('毎回 420k tok（約 $0.042）を読み直す。要約すると約 40k tok（約 $0.004）で、およそ 1/11 になる')
    const sub = stakeOf(facts({ contextTokens: 420_000, baselineTokens: 28_000, rateLimits: [{ kind: 'five_hour', percentUsed: 30 }] }))
    expect(stakeText(sub!)).toBe('毎回 420k tok を読み直す。要約すると約 40k tok で、およそ 1/11 になる')
    // Small: only what is carried, no word about summarising.
    expect(stakeText(stakeOf(facts({ contextTokens: 50_000, baselineTokens: 28_000 }))!)).toBe('毎回 50k tok を読み直す')
    // Dollars a request are thousandths: three places under a dime, two above.
    const opus = stakeText(stakeOf(facts({ contextTokens: 1_000_000, baselineTokens: 28_000, last: turn('claude-opus-5-5') }))!)
    expect(opus).toContain('毎回 1M tok（約 $0.20）')
    expect(opus).toContain('（約 $0.008）')
  })

  test('the status rows have it, after the context', () => {
    const rows = statusRows(facts({ contextPercent: 90, contextTokens: 420_000, contextWindow: 1_000_000, baselineTokens: 28_000 }))
    expect(rows.map(r => r.label).slice(0, 2)).toEqual(['コンテキスト', '毎回の読み直し'])
    expect(rows[1]?.value).toContain('毎回 420k tok を読み直す')
    expect(statusRows(initialFacts).some(r => r.label === '毎回の読み直し')).toBe(false)
  })
})

test('the pane has the row, and the band says nothing of it: the context gauge already says how big the conversation is', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)

  // 150k of a 1M window.
  await $.session.measure(measure.context(15, 1_000_000))
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...bandProps(), surface })
    expect(await band.find({ type: 'Text', text: '毎回' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '150k tok を読み直し' })).toBeUndefined()
    const pane = await $.ui.mount({ ...paneProps, surface })
    expect(await pane.find({ type: 'Text', text: '毎回の読み直し' })).toBeDefined()
  }

  // A small conversation: the pane says what is carried too, and the band still says nothing of it.
  await $.session.measure(measure.context(3, 1_000_000))
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...bandProps(), requestId: 'band-small', surface })
    expect(await band.find({ type: 'Text', text: '毎回' })).toBeUndefined()
  }
})
