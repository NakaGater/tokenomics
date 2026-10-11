import type { Facts, ModelRow, Modes, OfferKind } from '../../types'

import { THRESHOLDS, scaledPercent } from './advice'
import { formatTokens, limitLabel } from './format'
import { MODEL_LABEL, fitsWindow, lighterModels } from './modes'

export type OfferContext = { facts: Facts; modes: Modes; modelRow: ModelRow | null }

/** A way to spend fewer tokens, put to the person at a moment it pays off. Accepting carries it out. */
export type Offer = {
  /** The kind, or for a heavy conversation the kind and the level; stable while that situation lasts. */
  id: string
  kind: OfferKind
  level: 'notice' | 'warn'
  title: string
  /** Why now, in a sentence. */
  why: string
  /** What accepting does, in one line, including what it costs or saves on the person's behalf. */
  does: string
  /** The accept button. */
  accept: string
  /** The model to move to, for a model offer. */
  target?: string
}

export const OFFER_NAMES: Record<OfferKind, string> = {
  compact: '要約の提案',
  autocompact: '自動要約の提案',
  window: '自動要約の窓の提案',
  boundary: '区切りで新しく始める提案',
  worker: '軽量エージェントの提案',
  model: '軽いモデルへの提案',
  effort: '考える深さの提案',
  suggest: 'プロンプト提案をオフにする提案',
}

/** A heavy conversation is offered again in the next heavy spell; every other kind once a session. */
const EPISODE_PREFIX = 'compact-'

export const isEpisodeId = (id: string): boolean => id.startsWith(EPISODE_PREFIX)

type Rule = (c: OfferContext) => Offer | null

/** The size a shorter auto-compact window is proposed at, and the command that sets it. */
export const WINDOW_TOKENS = 200_000
export const WINDOW_COMMAND = '/autocompact 200k'

/** `default`, `best` and `opusplan` name no model by themselves: the last answer says which one answered. */
const AMBIGUOUS = ['default', 'best', 'opusplan']

const modelInUse = (row: ModelRow, f: Facts): string => (AMBIGUOUS.includes(row.value) && f.last !== null ? f.last.model : row.value)

/** Whether a rule will want the conversation's size, which costs a local estimate to learn: asked for only then. */
export const needsConversationSize = (f: Facts): boolean =>
  f.boundary !== null || f.lightStreak >= THRESHOLDS.lightStreak || f.rateLimits.some(r => r.percentUsed >= THRESHOLDS.modelOfferLimit)

const compact: Rule = ({ facts: f, modes }) => {
  const percent = scaledPercent(f)
  if (percent === null || percent < THRESHOLDS.contextNotice) return null
  const isFull = percent >= THRESHOLDS.contextWarn
  const isAutoOff = f.isAutoCompactEnabled === false
  return {
    id: isFull ? 'compact-90' : 'compact-70',
    kind: 'compact',
    level: isFull ? 'warn' : 'notice',
    title: isFull ? '会話がいっぱいに近づいています' : '会話が重くなってきました',
    why: isAutoOff
      ? '自動要約がオフなので、いっぱいになると自分での対応が必要になります。'
      : isFull
        ? 'このまま続けると自動で要約されます。残したい内容を守るには、先に要約するほうが安全です。'
        : '長い会話は、返信のたびに全体を読み直すぶん消費が増えます。要約すると、この先が軽くなります。',
    does: modes.isHandoffOn
      ? '失われやすい詳細をメモに残してから要約します。'
      : '失われやすい詳細をメモに残してから要約します。以降の要約でも、メモを残します。',
    accept: '要約する',
  }
}

const boundary: Rule = ({ facts: f }) => {
  // Only a conversation of some size has anything to lose: the window holds a good deal before the first word.
  if (f.boundary === null || f.conversationTokens === null || f.conversationTokens < THRESHOLDS.coldCacheContextTokens) return null
  return {
    id: 'boundary',
    kind: 'boundary',
    level: 'notice',
    title: f.boundary === 'commit' ? 'ひと区切りつきました' : '作業フォルダが変わりました',
    why: '続きが別の話なら、新しく始めるのが一番軽くなります。今の会話は、返信のたびに読み直されています。',
    does: '入力欄に /clear を入れます。Enter で実行します（今の会話は消えます）。',
    accept: '新しく始める',
  }
}

const autocompact: Rule = ({ facts: f }) => {
  if (f.isAutoCompactEnabled !== false || !f.canSetAutoCompact) return null
  if ((scaledPercent(f) ?? 0) < THRESHOLDS.contextNotice) return null
  return {
    id: 'autocompact',
    kind: 'autocompact',
    level: 'notice',
    title: '自動要約がオフです',
    why: 'いっぱいになったとき、自分で要約するまで待つことになります。',
    does: '自動要約をオンにします（設定に保存されます）。要約のたびに、メモも残します。',
    accept: 'オンにする',
  }
}

const window: Rule = ({ facts: f }) => {
  const threshold = f.autoCompactThreshold
  // Only where the engine's own size is in force: one the person or an administrator chose is theirs.
  if (threshold === null || threshold < THRESHOLDS.lateCompactTokens) return null
  if (f.autoCompactSource !== 'auto' && f.autoCompactSource !== 'model-default') return null
  // And once a conversation has grown to where waiting for it would hurt: also after the compaction that answered it.
  if (!f.hasGrown) return null
  return {
    id: 'window',
    kind: 'window',
    level: 'notice',
    title: '自動要約が、かなり先になっています',
    why: `いまの設定では、約${formatTokens(threshold)} tok まで育ってから自動で要約されます。返信のたびに会話全体を読み直すので、それまでずっと重いままです。`,
    does: `入力欄に ${WINDOW_COMMAND} を入れます。Enter で確定すると、自動要約の窓が約${formatTokens(WINDOW_TOKENS)} tok になります（自動要約は、窓がいっぱいになる少し手前で始まります。モデルごとに保存され、戻すには /autocompact auto）。`,
    accept: '入力欄に入れる',
  }
}

const worker: Rule = ({ facts: f, modes }) => {
  if (f.bigOutput === null || modes.isWorkerOn) return null
  return {
    id: 'worker',
    kind: 'worker',
    level: 'notice',
    title: `大きな読み込みがありました（約${formatTokens(f.bigOutput.tokens)} tok）`,
    why: '調べもののたびに本体の会話が膨らむと、以降の返信が毎回重くなります。',
    does: '調べもの用の軽いエージェント（Haiku）を使えるようにします。このセッションの間だけ。変更を伴うコマンドは、これまでどおり許可を聞かれます。',
    accept: '使えるようにする',
  }
}

const model: Rule = ({ facts: f, modes, modelRow: row }) => {
  if (row === null || modes.previousModel !== null) return null
  const convo = f.conversationTokens
  const target = lighterModels(modelInUse(row, f), row.options)[0]
  if (target === undefined || convo === null || convo > THRESHOLDS.smallContextTokens || !fitsWindow(target, f.contextTokens, f.contextWindow)) return null

  const limit = f.rateLimits.find(r => r.percentUsed >= THRESHOLDS.modelOfferLimit)
  if (limit === undefined && f.lightStreak < THRESHOLDS.lightStreak) return null
  const label = MODEL_LABEL[target] ?? target
  return {
    id: 'model',
    kind: 'model',
    level: 'notice',
    title: limit === undefined ? '軽いモデルで足りそうです' : `${limitLabel(limit.kind)}の上限が近づいています`,
    why: `いまは会話が小さい（約${formatTokens(convo)} tok）ので、切り替えて全体を読み直しても、約${formatTokens(f.contextTokens ?? convo)} tok で済みます。`,
    does: `${label} に切り替えます。終了するときに、元のモデルへ戻します。`,
    accept: `${label} にする`,
    target,
  }
}

const effort: Rule = ({ facts: f, modes }) => {
  if (modes.effort !== null || f.lightStreak < THRESHOLDS.lightStreak) return null
  if (f.stepEffort !== 'high' && f.stepEffort !== 'xhigh' && f.stepEffort !== 'max') return null
  return {
    id: 'effort',
    kind: 'effort',
    level: 'notice',
    title: '簡単な作業が続いています',
    why: '短い依頼と短い返事が続いています。考える深さを下げても足りることが多く、返信が軽くなります。',
    does: 'このセッションの間だけ、考える深さ（effort）を「ふつう」にします。公式ドキュメントでは、現行のモデルなら変えてもキャッシュは保たれるとされています。',
    accept: 'ふつうにする',
  }
}

const suggest: Rule = ({ facts: f }) => {
  if (f.isSuggestEnabled !== true || f.turns < THRESHOLDS.suggestAfterTurns) return null
  return {
    id: 'suggest',
    kind: 'suggest',
    level: 'notice',
    title: '返信ごとの「次の入力の候補」をオフにできます',
    why: '返信のたびに、次に打つ文の候補を作る小さなリクエストが走っています。',
    does: 'プロンプト提案をオフにします（設定に保存されます）。',
    accept: 'オフにする',
  }
}

/** Most urgent first: a conversation about to fill, then a natural break, then the rest. */
const RULES: Rule[] = [compact, boundary, autocompact, window, worker, model, effort, suggest]

/** Every suggestion that fits the situation now, muted or not, most urgent first. */
export const computeOffers = (c: OfferContext): Offer[] => RULES.flatMap(rule => rule(c) ?? [])

/** The suggestion to make now: the most urgent that has not been made yet and the person has not muted. */
export const nextOffer = (c: OfferContext, seen: readonly string[], muted: readonly OfferKind[]): Offer | null =>
  computeOffers(c).find(o => !muted.includes(o.kind) && !seen.includes(o.id)) ?? null

/** What is still on the table for the pane: everything that fits, less what was muted. */
export const standingOffers = (c: OfferContext, muted: readonly OfferKind[]): Offer[] =>
  computeOffers(c).filter(o => !muted.includes(o.kind))

/** The heavy-conversation spells still going on, so a finished spell is forgotten and a new one is offered anew. */
const activeEpisodes = (f: Facts): string[] => {
  const percent = scaledPercent(f) ?? 0
  return [percent >= THRESHOLDS.contextNotice ? 'compact-70' : '', percent >= THRESHOLDS.contextWarn ? 'compact-90' : ''].filter(
    id => id !== '',
  )
}

/** Keeps what was offered this session, less any spell of heavy conversation that has since ended. */
export const pruneSeen = (seen: string[], f: Facts): string[] => {
  const active = activeEpisodes(f)
  const kept = seen.filter(id => !isEpisodeId(id) || active.includes(id))
  // The same array when nothing ended, so the write does not redraw anyone for nothing.
  return kept.length === seen.length ? seen : kept
}
