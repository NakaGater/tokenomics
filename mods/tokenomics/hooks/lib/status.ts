import type { Facts, Savings } from '../../types'

import type { Advice } from './advice'
import { bar, clockLabel, formatTokens, formatUsd, limitLabel } from './format'
import { FACE, moodForLevel } from './mascot'
import type { Offer } from './offers'

export type Row = { label: string; value: string }

const NONE = 'まだありません'

/** What the savings layer has done today, in rows; nothing when it has done nothing yet. Dollars only off a subscription. */
export const savingsRows = (s: Savings, isSubscription: boolean): Row[] => {
  const rows: Row[] = []
  if (s.digests > 0) {
    rows.push({
      label: '今日の節約',
      value:
        `大きな出力を ${s.digests} 回縮め、約 ${formatTokens(s.tokens)} tok を会話に入れずに済みました` +
        (isSubscription ? '' : `（見込み約 ${formatUsd(s.milliUsd / 1000)}）`),
    })
  }
  if (s.wouldFire > 0) {
    rows.push({ label: '記録のみ', value: `提案できそうな場面を ${s.wouldFire} 回見つけました（この版では画面には出しません）` })
  }
  return rows
}

/** The state of the session in labelled rows: the pane draws them, the plain-text report prints them. */
export const statusRows = (f: Facts, savings?: Savings): Row[] => {
  const rows: Row[] = []

  rows.push({
    label: 'コンテキスト',
    value:
      f.contextPercent === null
        ? NONE
        : `${bar(f.contextPercent)} ${f.contextPercent}%` +
          (f.contextTokens !== null && f.contextWindow !== null
            ? `（${formatTokens(f.contextTokens)} / ${formatTokens(f.contextWindow)}）`
            : ''),
  })

  rows.push({
    label: '今回',
    value:
      f.last === null
        ? NONE
        : `${formatTokens(f.last.spent)} tok（入力 ${formatTokens(f.last.input + f.last.cacheWrite)} ・ 出力 ${formatTokens(f.last.output)}）` +
          (f.last.cacheRead > 0 ? ` ＋ キャッシュ再利用 ${formatTokens(f.last.cacheRead)}` : ''),
  })

  rows.push({
    label: 'このセッション',
    value: f.turns === 0 ? NONE : `${formatTokens(f.sessionTokens)} tok（${f.turns} ターン）`,
  })

  // The main loop's own turns are counted above; what subagents spent is counted, and kept apart, here.
  if (f.agentRuns > 0) {
    rows.push({ label: 'エージェント', value: `${formatTokens(f.agentTokens)} tok（${f.agentRuns} 回。上の数字には含みません）` })
  }

  // Off a subscription the dollars are what is spent; on one they are only a notional price.
  if (f.rateLimits.length === 0 && f.costUsd !== null) {
    rows.push({ label: '累計', value: `約 ${formatUsd(f.costUsd)}` })
  }

  for (const limit of f.rateLimits) {
    const resets = clockLabel(limit.resetsAt)
    rows.push({
      label: `${limitLabel(limit.kind)}の上限`,
      value: `${Math.floor(limit.percentUsed)}% 使用${resets === undefined ? '' : `（${resets} にリセット）`}`,
    })
  }

  if (savings !== undefined) rows.push(...savingsRows(savings, f.rateLimits.length > 0))

  return rows
}

export const NOTHING_TO_DO = '今は何もしなくて大丈夫です。'

/** The same content as the pane, as text, for a terminal too narrow to seat one. */
export const report = (f: Facts, advice: readonly Advice[], offers: readonly Offer[], savings?: Savings): string => {
  const top = offers[0] ?? advice[0]
  const lines: string[] = [`${FACE[moodForLevel(top?.level ?? 'ok')]} トークン消費`]
  for (const row of statusRows(f, savings)) lines.push(`  ${row.label}  ${row.value}`)

  lines.push('', '今やること')
  if (advice.length === 0 && offers.length === 0) {
    lines.push(`  ${NOTHING_TO_DO}`)
    return lines.join('\n')
  }
  for (const o of offers) lines.push(`  ・${o.title}`, `    ${o.why}`, `    受け入れると: ${o.does}`)
  for (const a of advice) lines.push(`  ・${a.title}`, `    ${a.detail}`)
  if (offers.length > 0) lines.push('', '  受け入れる操作は、プロンプトの上の枠、または /tokenomics のパネルにあります。')
  return lines.join('\n')
}
