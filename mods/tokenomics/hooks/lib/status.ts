import type { Facts, OfferKind, Savings } from '../../types'

import type { Advice } from './advice'
import { sessionOf } from './facts'
import { bar, clockLabel, exactTokens, formatTokens, formatUsd, limitLabel, promptTokens, promptsOf } from './format'
import { type Fill, fillOf } from './gauge'
import { stakeOf, stakeText } from './stake'
import { FACE, moodForLevel } from './mascot'
import type { ActiveSaving } from './modes'
import { OFFER_NAMES, type Offer } from './offers'
import { commandOf, currentLine, windowView } from './window'

export type Row = { label: string; value: string }

const NONE = 'まだありません'

/** Thousandths of a dollar as a signed amount: "約 $0.01", or "約 −$0.01" where the cost was the larger. */
const signedUsd = (milli: number): string => `約 ${milli < 0 ? '−' : ''}${formatUsd(Math.abs(milli) / 1000)}`

/**
 * Everything the savings layer kept out, as the band says it in one figure: the digest's cuts (確定) and the reading handed to
 * a skill or agent (推定), each added up over the requests it spared once it was out of the conversation (延べ), and the outputs cut
 * inside subagents, as they were cut. Where no request has followed a kind yet (or the ledger is from before they were counted)
 * its size as it was cut stands in. It is a figure to show: the ledger and the pilot report keep the kinds apart.
 */
export const savedAll = (s: Savings): { tokens: number; digest: number; delegated: number; isSpread: boolean; isEstimated: boolean } => {
  const digest = Math.max(s.tokens, s.flowTokens)
  const delegated = Math.max(s.keptTokens, s.flowKeptTokens)

  return { tokens: digest + delegated + s.subTokens, digest, delegated, isSpread: s.flowReqs > 0, isEstimated: delegated > 0 || s.subTokens > 0 }
}

/**
 * What the savings layer has kept out of this session, in one row: the band's figure, with what it is made of. The day's rows (below)
 * are every session's; this is the one the band says, and `/clear` starts it over. Nothing when it has kept nothing out.
 */
export const sessionSavingRows = (s: Savings): Row[] => {
  const all = savedAll(s)
  if (all.tokens <= 0) return []
  const parts: string[] = []
  if (all.digest > 0) parts.push(`確定 ${formatTokens(all.digest)}`)
  if (all.delegated > 0) parts.push(`推定 ${formatTokens(all.delegated)}`)
  if (s.subTokens > 0) parts.push(`サブエージェント内 ${formatTokens(s.subTokens)}`)

  return [
    {
      label: 'このセッションの節約',
      value:
        `約 ${formatTokens(all.tokens)} tok（帯の「節約（延べ）」と同じ数字）＝ ${parts.join(' ＋ ')}` +
        (all.isSpread ? '。確定と推定は延べ' : '') +
        (all.isEstimated ? '。推定を含む' : '') +
        '。/clear で数え直します',
    },
  ]
}

/**
 * What the savings layer has done today, in rows; nothing when it has done nothing yet. Dollars only off a subscription.
 * The digest's figure is a cut that happened (確定); the next is an estimate of the reading that work handed to a skill or
 * agent kept out of the conversation, and a cautious one; the last is what the cuts inside subagents spared them. Each has a row
 * of its own, as it was cut. What was kept out spares every request that follows, so one more row counts that (延べ), in tokens and,
 * measured on the requests that were made, in dollars; and a row on top adds the kinds up.
 */
export const savingsRows = (s: Savings, isSubscription: boolean): Row[] => {
  const rows: Row[] = []
  const all = savedAll(s)
  const parts: string[] = []
  if (all.digest > 0) parts.push(`確定 ${formatTokens(all.digest)}`)
  if (all.delegated > 0) parts.push(`推定 ${formatTokens(all.delegated)}`)
  if (s.subTokens > 0) parts.push(`サブエージェント内 ${formatTokens(s.subTokens)}`)
  if (parts.length > 1 || all.isSpread) {
    rows.push({
      label: '今日の節約（合計）',
      value:
        `約 ${formatTokens(all.tokens)} tok ＝ ${parts.join(' ＋ ')}（今日、この端末のすべてのセッションの分` +
        (all.isSpread ? '。確定と推定は延べ' : '') +
        (all.isEstimated ? '。推定を含む' : '') +
        '）',
    })
  }
  if (all.isSpread) {
    rows.push({
      label: '今日の節約（延べ）',
      value:
        `会話に入れずに済ませた分が、のべ ${s.flowReqs} 回のリクエストに載らずに済みました（延べ約 ${formatTokens(s.flowTokens + s.flowKeptTokens)} tok` +
        (isSubscription ? '' : `、入力側の見込み約 ${formatUsd(s.flowMicroUsd / 1_000_000)}`) +
        '）。/clear や要約で数え直します。エンジンが先に古いツール結果を片付けたときは、多めに出ます',
    })
  }
  if (s.digests > 0) {
    rows.push({
      label: '今日の節約（確定）',
      value:
        `大きな出力を ${s.digests} 回縮め、約 ${formatTokens(s.tokens)} tok を会話に入れずに済みました` +
        // The measured dollars are in the row above once requests were counted; the assumed ones would be a second amount for the same thing.
        (isSubscription || all.isSpread ? '' : `（見込み約 ${formatUsd(s.milliUsd / 1000)}）`) +
        (s.recovered > 0 ? `。あとで全文を取りに戻ったのは ${s.recovered} 回` : ''),
    })
  }
  if (s.forks > 0) {
    rows.push({
      label: '今日の節約（推定）',
      value:
        `調べものやテストを ${s.forks} 回任せ、会話に入れずに済んだ読み込みは約 ${formatTokens(s.keptTokens)} tok（控えめな推定）` +
        // The runs' own cost is set against it: a run is paid for even when it kept nothing out.
        (isSubscription
          ? ''
          : `、見込み約 ${formatUsd(s.keptMilliUsd / 1000)}。任せた先の費用は約 ${formatUsd(s.forkCostMilliUsd / 1000)}（入力側）で、差し引き ${signedUsd(s.keptMilliUsd - s.forkCostMilliUsd)}`) +
        (s.forkLosses > 0 ? `。報告が読んだ量以上で、得にならなかったのは ${s.forkLosses} 回` : '') +
        (s.forkReaders > 0 ? `。ファイルを読んだ ${s.forkReaders} 回のあと、会話側が同じファイルを読み直したのは ${s.forkRereads} 件` : ''),
    })
  }
  if (s.subCuts > 0) {
    rows.push({
      label: '今日の節約（サブ）',
      value: `サブエージェントが読む大きな出力を ${s.subCuts} 回縮め、約 ${formatTokens(s.subTokens)} tok を読まずに済ませました（会話が読むものではない分。上の「確定」には入れていません）`,
    })
  }
  if (s.wouldFire > 0) {
    rows.push({ label: '記録のみ', value: `提案できそうな場面を ${s.wouldFire} 回見つけました（この版では画面には出しません）` })
  }
  return rows
}

/**
 * What stands beside the context's percent: the conversation as it stands (the prompt the next request sends) against the size
 * the percent is counted in, and what is left before the auto-compaction.
 */
const fillNote = (f: Facts, fill: Fill): string => {
  if (fill.tokens === null || fill.limit === null) return ''
  const now = `いまの会話 ${formatTokens(fill.tokens)} tok`
  if (fill.isCompactAt) {
    return `（${now} / 自動要約の大きさ ${formatTokens(fill.limit)} tok。あと約 ${formatTokens(Math.max(0, fill.limit - fill.tokens))} tok で自動要約）`
  }
  return f.isAutoCompactEnabled === false
    ? `（${now} / 窓 ${formatTokens(fill.limit)} tok。自動要約はオフ）`
    : `（${now} / 窓 ${formatTokens(fill.limit)} tok）`
}

/** The state of the session in labelled rows: the pane draws them, the plain-text report prints them. */
export const statusRows = (f: Facts, savings?: Savings, sessionSavings?: Savings): Row[] => {
  const rows: Row[] = []

  const fill = fillOf(f)
  rows.push({
    label: 'コンテキスト',
    value: f.contextPercent === null ? NONE : `${bar(fill.percent)} ${fill.percent}%${fillNote(f, fill)}`,
  })

  // What carrying the conversation costs on every request, and what a summary would change: the reason to summarise, in numbers.
  const stake = stakeOf(f)
  if (stake !== null) rows.push({ label: '毎回の読み直し', value: stakeText(stake) })

  // The last turn as the API counted it, in full, so that it can be priced: the prompt in the three kinds that are billed apart,
  // and the output. A turn is several requests (each tool call is followed by another), every one sending the whole conversation,
  // so these are sums over the requests: the cache read is the conversation read once per request.
  if (f.last === null) {
    rows.push({ label: '今回', value: NONE })
  } else {
    const t = f.last
    const prompts = promptsOf(t)
    const n = prompts.length
    const sum = n > 1 ? `（${n} 回の合計）` : ''
    if (n > 0) {
      const first = exactTokens(prompts[0] ?? 0)
      const last = exactTokens(prompts[n - 1] ?? 0)
      rows.push({
        label: '今回のリクエスト',
        value: n === 1 ? `1 回（会話全体 ${first} tok を送った）` : `${n} 回（毎回、会話全体を送る。1回目 ${first} tok → 最後 ${last} tok）`,
      })
    }
    rows.push({
      label: '今回の入力',
      value: `${exactTokens(promptTokens(t))} tok${sum} ＝ キャッシュ読み ${exactTokens(t.cacheRead)} ＋ キャッシュ書き込み ${exactTokens(t.cacheWrite)} ＋ キャッシュなし ${exactTokens(t.input)}`,
    })
    rows.push({ label: '今回の出力', value: `${exactTokens(t.output)} tok（${n > 1 ? `${n} 回の合計。` : ''}考えた分を含む）` })
    rows.push({ label: '今回のモデル', value: t.model })
  }

  // The session so far, in the same kinds as the last turn: sums over every request of every turn since it began (or since /clear).
  const session = sessionOf(f)
  if (f.turns === 0) {
    rows.push({ label: 'このセッション', value: NONE })
  } else if (session.turns === 0) {
    // Turns were taken before the totals were kept (the mod was reloaded from an older build), and none has ended since.
    rows.push({ label: 'このセッション', value: `次のターンから数えます（これ以前の ${f.turns} ターンは含みません）` })
  } else {
    const scope =
      `${session.turns} ターン` +
      // Requests are named only where every turn had them counted.
      (session.requestTurns === session.turns ? `・リクエスト ${session.requests} 回` : '') +
      'の合計' +
      // Turns from before this was counted (the mod was reloaded from an older build) have no breakdown.
      (f.turns > session.turns ? `。これ以前の ${f.turns - session.turns} ターンは含みません` : '')
    const prompt = session.input + session.cacheWrite + session.cacheRead
    rows.push({
      label: 'このセッションの入力',
      value: `${exactTokens(prompt)} tok（${scope}） ＝ キャッシュ読み ${exactTokens(session.cacheRead)} ＋ キャッシュ書き込み ${exactTokens(session.cacheWrite)} ＋ キャッシュなし ${exactTokens(session.input)}`,
    })
    rows.push({ label: 'このセッションの出力', value: `${exactTokens(session.output)} tok（考えた分を含む）` })
  }

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

  if (sessionSavings !== undefined) rows.push(...sessionSavingRows(sessionSavings))
  if (savings !== undefined) rows.push(...savingsRows(savings, f.rateLimits.length > 0))

  return rows
}

export const NOTHING_TO_DO = '今は何もしなくて大丈夫です。'

/** The same content as the pane, as text, for a terminal too narrow to seat one. */
export const report = (f: Facts, advice: readonly Advice[], offers: readonly Offer[], savings?: Savings, sessionSavings?: Savings): string => {
  const top = offers[0] ?? advice[0]
  const lines: string[] = [`${FACE[moodForLevel(top?.level ?? 'ok')]} トークン消費`]
  for (const row of statusRows(f, savings, sessionSavings)) lines.push(`  ${row.label}  ${row.value}`)

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

/**
 * The settings, as text, for a terminal too narrow for the pane: the auto-compact size in force and how to change it, what is
 * running that the person accepted, and the suggestions put off.
 */
export const settingsReport = (f: Facts, active: readonly ActiveSaving[], muted: readonly OfferKind[]): string => {
  const view = windowView(f)
  const lines: string[] = ['⚙ トークン消費の設定', '', '自動要約のタイミング']
  if (view === null) lines.push('  このモデルの窓では、選べる大きさがありません。')
  else lines.push(`  ${currentLine(view, f.rateLimits.length === 0)}`, `  変えるには: ${commandOf(view, 300_000)}（100k〜1M。標準に戻すには /autocompact auto）`)
  lines.push('', 'いま効いている節約')
  if (active.length === 0) lines.push('  ありません。')
  for (const a of active) lines.push(`  ・${a.label}`)
  if (muted.length > 0) lines.push('', '止めている提案', ...muted.map(kind => `  ・${OFFER_NAMES[kind]}`))
  return lines.join('\n')
}
