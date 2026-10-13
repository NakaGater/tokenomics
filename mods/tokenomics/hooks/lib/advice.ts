import type { Facts } from '../../types'

import { clockLabel, formatTokens, formatUsd, limitLabel } from './format'

export const THRESHOLDS = {
  contextNotice: 70,
  contextWarn: 90,
  limitNotice: 80,
  limitWarn: 95,
  /** A tool result worth a word, in estimated tokens. */
  bigOutputTokens: 10_000,
  /** A pause after which the prompt cache has probably lapsed. */
  idleMs: 5 * 60 * 1000,
  /** Below this the context is too small for a lapsed cache to matter. */
  coldCacheContextTokens: 20_000,
  /** After a pause, a turn that wrote back this share of the context into the cache is one that read it all again. */
  cacheLapseShare: 0.5,
  /** Re-caching a conversation for a model switch below this is not worth asking about. */
  modelSwitchUsd: 0.05,
  /** A small turn: a short prompt, at most this many tool calls, a short answer. */
  lightPromptChars: 80,
  lightTools: 1,
  /** Judged by what is shown, not by output tokens: thinking is billed as output and cannot be turned off on the 5 series. */
  lightAnswerChars: 600,
  /** Small turns in a row before lowering the effort is worth proposing. */
  lightStreak: 3,
  /** A conversation this small is cheap to read again, so a model switch is worth proposing. */
  smallContextTokens: 20_000,
  /** A subscription limit this far gone makes a lighter model worth proposing. */
  modelOfferLimit: 70,
  /** Turns before "prompt suggestions" are worth mentioning: the small request after each reply adds up. */
  suggestAfterTurns: 5,
  /** An auto-compact size above this is later than any conversation is worth carrying: a shorter one is worth proposing. */
  lateCompactTokens: 400_000,
} as const

/**
 * Something worth knowing, with nothing to press. What the person can act on is an Offer
 * (lib/offers.ts); this is what they are told.
 */
export type Advice = {
  /** Stable while the condition holds, so a dismissal sticks; changes when it begins again. */
  id: string
  level: 'notice' | 'warn'
  /** One short sentence for the band. */
  title: string
  /** Why, and what to do, for the pane. */
  detail: string
}

export type ContextLevel = 'ok' | 'notice' | 'warn'

/**
 * The window the thresholds are counted in: the model's, or 200k where it is larger. Every reply reads the whole
 * conversation again, so a conversation costs the same however large the window around it: 150k tokens is
 * heavy in a window of a million as much as in one of 200k. The gauge keeps showing the real share of the window.
 */
export const REFERENCE_WINDOW = 200_000

/** How full the context is on the scale the thresholds use: the engine's own percent in a window up to 200k. */
export const scaledPercent = (f: Facts): number | null => {
  if (f.contextTokens === null || f.contextWindow === null || f.contextWindow <= REFERENCE_WINDOW) return f.contextPercent
  return Math.min(100, Math.round((f.contextTokens / REFERENCE_WINDOW) * 100))
}

export const contextLevel = (percent: number | null): ContextLevel => {
  if (percent === null) return 'ok'
  if (percent >= THRESHOLDS.contextWarn) return 'warn'
  if (percent >= THRESHOLDS.contextNotice) return 'notice'
  return 'ok'
}

const TOOL_LABELS: Record<string, string> = {
  Read: 'ファイル読み込み',
  Bash: 'コマンド',
  Grep: '検索',
  Glob: 'ファイル検索',
  WebFetch: 'Web取得',
  WebSearch: 'Web検索',
}

const bigOutputHint = (tool: string): string => {
  if (tool === 'Read') return 'ファイルは全体ではなく範囲(offset / limit)を指定するか、先に検索で場所を絞ってから読みましょう。'
  if (tool === 'Bash') return 'コマンドの出力は、head・grep・wc などで絞ってから受け取りましょう。'
  if (tool === 'Grep' || tool === 'Glob') return '検索のパターンやフォルダを狭めると、結果が小さくなります。'
  return '結果を絞り込める指定があれば使いましょう。'
}

const idleLabel = (minutes: number): string => (minutes >= 120 ? `約${Math.round(minutes / 60)}時間` : `約${Math.max(1, minutes)}分`)

/** Everything worth telling right now, most urgent first. A heavy conversation is not here: it is an offer. */
export const computeAdvice = (f: Facts): Advice[] => {
  const out: { rank: number; advice: Advice }[] = []
  const add = (rank: number, advice: Advice): void => {
    out.push({ rank, advice })
  }

  for (const limit of f.rateLimits) {
    if (limit.percentUsed < THRESHOLDS.limitNotice) continue
    const isWarn = limit.percentUsed >= THRESHOLDS.limitWarn
    const resets = clockLabel(limit.resetsAt)
    add(isWarn ? 0 : 1, {
      id: `limit-${limit.kind}`,
      level: isWarn ? 'warn' : 'notice',
      title: `${limitLabel(limit.kind)}の上限の${Math.floor(limit.percentUsed)}%を使いました`,
      detail: `重い作業は後に回すか、軽いモデルや低めの effort に切り替えると長く使えます。${resets === undefined ? '' : `リセットは ${resets} ごろです。`}`,
    })
  }

  if (f.bigOutput !== null) {
    const label = TOOL_LABELS[f.bigOutput.tool] ?? f.bigOutput.tool
    const where = f.bigOutput.target === undefined ? '' : `（${f.bigOutput.target}）`
    add(2, {
      id: `big-${f.bigOutput.id}`,
      level: 'notice',
      title: `${label}の出力が大きめでした（約${formatTokens(f.bigOutput.tokens)} tok）`,
      detail: `${label}${where}の結果が会話に入りました。この分は、以降の返信でも毎回読み直されます。${bigOutputHint(f.bigOutput.tool)}`,
    })
  }

  if (f.resumeCold !== null) {
    const r = f.resumeCold
    // On a subscription nothing is charged per token: what a re-read costs is the limit it uses up.
    const price = f.rateLimits.length > 0 ? 'そのぶん上限を多く使います' : `読み直しに約${formatUsd(r.usd)}かかります`
    add(1, {
      id: 'resume-cold',
      level: 'notice',
      title: `前回から${idleLabel(r.idleMinutes)}あきました。最初の返信で会話全体（約${formatTokens(r.tokens)} tok）を読み直します`,
      detail: `キャッシュが切れているので、${price}。要約してから始めても、最初の1回は同じ読み直しになります。続きが別の話なら、/clear で新しく始めるのが一番軽くなります。`,
    })
  }

  if (f.cacheLapse !== null) {
    add(3, {
      id: 'cache-lapse',
      level: 'notice',
      title: `しばらく空いたため、会話の読み直しが発生しました（約${formatTokens(f.cacheLapse.tokens)} tok）`,
      detail:
        'キャッシュが切れると、再開の最初の返信で会話全体を読み直すぶん消費が増えます。区切りの良いところで要約するか新しく始めておくと、再開が軽くなります。',
    })
  }

  return out.sort((a, b) => a.rank - b.rank).map(o => o.advice)
}

/** What the band shows: the most urgent advice the person has not put off. */
export const nextAdvice = (f: Facts, dismissed: readonly string[]): Advice | null =>
  computeAdvice(f).find(a => !dismissed.includes(a.id)) ?? null
