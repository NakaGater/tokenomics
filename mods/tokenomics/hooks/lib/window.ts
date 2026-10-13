import type { Facts } from '../../types'

import { formatTokens } from './format'

/**
 * The auto-compact window, as `/autocompact` takes it (100k to 1M): the size the engine measures the conversation against.
 * It compacts a little before the window is full, so the person picks the window and the mod says where compaction starts.
 */
export const WINDOW_RECOMMENDED = 300_000

/**
 * What the engine keeps back between the window and the size it compacts at, when the two have not both been read: 33k at
 * every size seen (a window of 500k compacts at 467k, one of 1M at 967k).
 */
export const FALLBACK_BUFFER = 33_000

/** The pane offers the choice only where the window is larger than the recommended size: a 200k window is already short. */
export const MIN_MODEL_WINDOW = 400_000

/** One window the pane offers, and what the sessions measured here say of it. */
export type WindowStop = {
  tokens: number
  /**
   * How much less the long sessions spent, in percent, than with the window at 1M (the engine's standard), to the nearest 5:
   * the model is no finer than that.
   */
  saving: number
  /** How many times a long session compacted. */
  times: number
}

/**
 * Measured on this machine: the five largest sessions (about 3,000 requests, $240 of real spend) replayed with the window at
 * each size. Each request reads the whole conversation at the cache-read price and writes what it adds at the cache-write price;
 * a compaction reads the conversation once, writes a fresh 40k start, pays the summary's output (12k tokens at 5 times the
 * input price) and re-reads 6k of files. What is left out is what a summary loses.
 *
 * It is a long-session figure: a conversation that never reaches the compaction size spends the same at every setting.
 * 100k saves less than 150k because the compactions themselves add up (about 46 a session).
 */
export const WINDOW_STOPS: readonly WindowStop[] = [
  { tokens: 100_000, saving: 25, times: 46 },
  { tokens: 150_000, saving: 50, times: 17 },
  { tokens: 200_000, saving: 50, times: 11 },
  { tokens: 250_000, saving: 50, times: 8 },
  { tokens: 300_000, saving: 45, times: 6 },
  { tokens: 350_000, saving: 45, times: 5 },
  { tokens: 400_000, saving: 40, times: 4 },
  { tokens: 500_000, saving: 35, times: 3 },
  { tokens: 600_000, saving: 20, times: 3 },
  { tokens: 700_000, saving: 15, times: 2 },
  { tokens: 800_000, saving: 5, times: 2 },
  { tokens: 900_000, saving: 0, times: 2 },
  { tokens: 1_000_000, saving: 0, times: 1 },
]

const nearest5 = (n: number): number => Math.round(n / 5) * 5

/** The saving at any window, between the stops in a straight line, and the end values beyond them. */
export const savingAt = (tokens: number): number => {
  const first = WINDOW_STOPS[0]!
  const last = WINDOW_STOPS[WINDOW_STOPS.length - 1]!
  if (tokens <= first.tokens) return first.saving
  if (tokens >= last.tokens) return last.saving
  const upper = WINDOW_STOPS.findIndex(s => s.tokens >= tokens)
  const a = WINDOW_STOPS[upper - 1]!
  const b = WINDOW_STOPS[upper]!
  return a.saving + ((b.saving - a.saving) * (tokens - a.tokens)) / (b.tokens - a.tokens)
}

/** What a window saves against another, in percent to the nearest 5: negative where it spends more. */
export const savingAgainst = (tokens: number, base: number): number => {
  const spent = 1 - savingAt(tokens) / 100
  const spentBase = 1 - savingAt(base) / 100
  return nearest5(100 * (1 - spent / spentBase))
}

/** What the pane needs to draw the choice. */
export type WindowView = {
  /** The windows the model allows, smallest first. */
  stops: readonly WindowStop[]
  /** The window in force: the setting, or the model's own. */
  current: number
  /** The model's own window: what the engine uses unless told otherwise. */
  standard: number
  /** Between the window and the size compaction starts at. */
  buffer: number
  /** Auto-compaction is off: there is no window to choose. */
  isOff: boolean
  /** An environment variable, an administrator or an experiment chose it: a command here may not take. */
  isOwned: boolean
}

const OWNED = ['env', 'clientdata', 'experiment']

export const windowView = (f: Facts): WindowView | null => {
  const standard = f.contextWindow
  if (standard === null || standard < MIN_MODEL_WINDOW) return null
  // The model's own limit is read live, with every measure; the breakdown is read now and then, and a size is only its to tell when someone set one.
  const current = f.autoCompactSource === 'auto' ? standard : (f.autoCompactWindow ?? standard)
  const threshold = f.autoCompactThreshold
  return {
    stops: WINDOW_STOPS.filter(s => s.tokens <= standard),
    current,
    standard,
    buffer: threshold !== null && threshold < current ? current - threshold : FALLBACK_BUFFER,
    isOff: f.isAutoCompactEnabled === false,
    isOwned: f.autoCompactSource !== null && OWNED.includes(f.autoCompactSource),
  }
}

/** The stop chosen: the one asked for, else the recommended one, else the largest the model allows. */
export const pickOf = (v: WindowView, asked: number | null): number => {
  const has = (n: number): boolean => v.stops.some(s => s.tokens === n)
  if (asked !== null && has(asked)) return asked
  if (has(WINDOW_RECOMMENDED)) return WINDOW_RECOMMENDED
  return v.stops[v.stops.length - 1]?.tokens ?? v.standard
}

/** The stop one step from `pick`, or the same one at an end. */
export const stepPick = (v: WindowView, pick: number, direction: -1 | 1): number => {
  const at = v.stops.findIndex(s => s.tokens === pick)
  return v.stops[Math.max(0, Math.min(v.stops.length - 1, at + direction))]?.tokens ?? pick
}

/** What `/autocompact` is given for a window: the model's own window is "auto", which also takes the setting off the file. */
export const commandArg = (v: WindowView, tokens: number): string => (tokens >= v.standard ? 'auto' : `${Math.round(tokens / 1000)}k`)

export const commandOf = (v: WindowView, tokens: number): string => `/autocompact ${commandArg(v, tokens)}`

const stopOf = (v: WindowView, tokens: number): WindowStop | undefined => v.stops.find(s => s.tokens === tokens)

/** The size compaction starts at under a window. */
export const startsAt = (v: WindowView, tokens: number): number => tokens - v.buffer

const spent = (isDollars: boolean): string => (isDollars ? '費用' : '使用量')

/** The sentence over the track: the window in force, and what it saves against the standard. */
export const currentLine = (v: WindowView, isDollars: boolean): string => {
  if (v.isOff) return '自動要約がオフです。ここでタイミングを選んでも、オンにするまで要約は始まりません。'
  const start = formatTokens(startsAt(v, v.current))
  if (v.current >= v.standard) return `いま: ${formatTokens(v.current)}（標準）。約 ${start} tok まで育ってから要約されます。`
  const saving = savingAgainst(v.current, v.standard)
  const effect = saving > 0 ? `標準より ${spent(isDollars)}が約 ${saving}% 少ない目安` : '標準と変わらない目安'
  return `いま: ${formatTokens(v.current)}。約 ${start} tok で要約が始まり、${effect}。`
}

/** What the chosen stop comes to, in the lines the pane writes under the track. */
export type PickLines = {
  title: string
  isRecommended: boolean
  isCurrent: boolean
  /** What it saves (or costs more) against the standard size and against the one in force. */
  againstStandard: string
  againstNow: string
  starts: string
  times: string
  /** Why the recommended stop is recommended; empty for the others. */
  reason: string
  command: string
}

export const REASON =
  '削減は最大の約50%（150k〜250k）に近く、要約の回数は 200k の約半分。詳細を失う機会が少なく、取り戻す読み直しも減ります。'

export const pickLines = (v: WindowView, tokens: number): PickLines => {
  const stop = stopOf(v, tokens)
  const against = savingAgainst(tokens, v.standard)
  const versus = savingAgainst(tokens, v.current)
  const standard = formatTokens(v.standard)
  const now = formatTokens(v.current)
  const isCurrent = tokens === v.current || (tokens >= v.standard && v.current >= v.standard)
  const vsNow = isCurrent
    ? '今の設定です'
    : versus > 0
      ? `今の ${now} より 約 ${versus}% 少ない`
      : versus < 0
        ? `今の ${now} より 約 ${-versus}% 多い`
        : `今の ${now} と変わらない`
  const vsStandard = tokens >= v.standard ? '標準のサイズです' : against > 0 ? `標準の ${standard} より 約 ${against}% 少ない` : `標準の ${standard} と変わらない`
  return {
    title: formatTokens(tokens),
    isRecommended: tokens === WINDOW_RECOMMENDED,
    isCurrent,
    againstStandard: vsStandard,
    againstNow: vsNow,
    starts: tokens >= v.standard ? `約 ${formatTokens(startsAt(v, tokens))} tok` : `約 ${formatTokens(startsAt(v, tokens))} tok から`,
    times: stop === undefined ? '' : `約 ${stop.times} 回（長く続く会話 1 本あたり）`,
    reason: tokens === WINDOW_RECOMMENDED ? REASON : '',
    command: commandOf(v, tokens),
  }
}

export const WINDOW_NOTE =
  'この PC で最も大きかった 5 つのセッションを、各設定で再計算した目安です。要約の出力と読み直しの費用は含み、要約で失う細部は含みません。会話が短いうちは、どの設定でも変わりません。'

/**
 * The ruler under the track: the sizes named at their stops, in plain characters so each sits where its stop is
 * (a stop every `spacing` cells).
 */
export const rulerOf = (v: WindowView, spacing: number): string => {
  const width = (v.stops.length - 1) * spacing + 1
  const row = Array.from({ length: width }, () => ' ')
  const named = new Set([100_000, WINDOW_RECOMMENDED, 500_000, 1_000_000, v.stops[v.stops.length - 1]?.tokens])
  let end = -1
  v.stops.forEach((s, i) => {
    if (!named.has(s.tokens)) return
    const label = formatTokens(s.tokens)
    const at = i === v.stops.length - 1 ? Math.max(0, width - label.length) : i * spacing
    if (at <= end) return
    for (let k = 0; k < label.length; k += 1) row[at + k] = label[k]!
    end = at + label.length
  })
  return row.join('').trimEnd()
}
