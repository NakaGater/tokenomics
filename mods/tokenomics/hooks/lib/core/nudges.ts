import { formatTokens, formatUsd } from '../format'

/**
 * One-line suggestions (C1 to C3), and the rules for how rarely they are made. They come after a reply, as a line of
 * the mod's own; they never stop a prompt, and nothing is typed for the person: starting fresh is their command to give.
 */
export type NudgeMeasure = 'C1' | 'C2' | 'C3'

export type Candidate = {
  measure: NudgeMeasure
  /** A short word for what kind of moment it was (`notice`, `strong`, `keyword_gap`, `50to100k`). */
  tag: string
  /** The main turn count when it arose. */
  turn: number
  /** How big the conversation was, in tokens. */
  ctx: number
  /** What the suggestion would spare, in thousandths of a dollar; null where the model has no price. */
  stakeMilliUsd: number | null
  /** Only worth saying if the turn it was made in really did re-read the whole conversation (the cache had lapsed). */
  needsCold: boolean
}

/** Off an API key's dollars, a suggestion that would spare less than this is not worth a line (5 cents). */
export const MIN_STAKE_MILLI = 50
/** At least this many turns between two suggestions. */
export const MIN_GAP_TURNS = 3
/** A candidate not made use of within this many turns is stale. */
export const CANDIDATE_TURNS = 2

export type Held = 'stake' | 'gap' | 'multi'

export type Choice = { shown: Candidate | null; held: { candidate: Candidate; why: Held }[] }

export type Situation = {
  /** The main turns finished so far, counting the one just ended. */
  turn: number
  lastShownTurn: number | null
  isSubscription: boolean
  /** The turn that just ended wrote its prompt into the cache again after a pause. */
  isColdTurn: boolean
}

const rank = (c: Candidate): number => (c.measure === 'C2' && c.tag === 'strong' ? 4 : c.measure === 'C3' ? 3 : c.measure === 'C1' ? 2 : 1)

/**
 * Which one suggestion, if any, is made now. Friction is kept in proportion to what is at stake: on an API key a
 * suggestion that would spare under five cents is held back; at most one is made per turn, and not within three
 * turns of the last. The ones held back are returned, so the ledger can say what would have been said.
 */
export const chooseNudge = (candidates: readonly Candidate[], s: Situation): Choice => {
  const fresh = candidates.filter(c => s.turn - c.turn <= CANDIDATE_TURNS && (!c.needsCold || s.isColdTurn))
  const held: Choice['held'] = []
  const worth: Candidate[] = []
  for (const c of fresh) {
    if (!s.isSubscription && c.stakeMilliUsd !== null && c.stakeMilliUsd < MIN_STAKE_MILLI) held.push({ candidate: c, why: 'stake' })
    else worth.push(c)
  }
  if (worth.length === 0) return { shown: null, held }
  if (s.lastShownTurn !== null && s.turn - s.lastShownTurn < MIN_GAP_TURNS) {
    return { shown: null, held: [...held, ...worth.map(candidate => ({ candidate, why: 'gap' as const }))] }
  }
  const best = worth.reduce((a, b) => (rank(b) > rank(a) ? b : a))
  return { shown: best, held: [...held, ...worth.filter(c => c !== best).map(candidate => ({ candidate, why: 'multi' as const }))] }
}

const dollars = (milli: number | null, isSubscription: boolean): string =>
  isSubscription || milli === null || milli <= 0 ? '' : `（約 ${formatUsd(milli / 1000)}）`

/** The line, in the person's words. `costMilliUsd` is what a lapsed cache cost the turn just ended, for the one that says so. */
export const nudgeLine = (c: Candidate, isSubscription: boolean, costMilliUsd: number | null = null): string => {
  const tokens = formatTokens(c.ctx)
  if (c.measure === 'C2') {
    return c.tag === 'strong'
      ? `会話がかなり重くなっています（返信のたびに約 ${tokens} tok を読み直します）。/compact で要約するか、別件なら /clear で新しく始めると軽くなります。`
      : `会話が重くなってきました（返信のたびに約 ${tokens} tok を読み直します）。区切りのよいところで /compact を。`
  }
  if (c.measure === 'C3') {
    return `しばらく空いたため、会話全体（約 ${tokens} tok）を読み直しました${dollars(costMilliUsd, isSubscription)}。続きが別件なら、/clear が一番軽くなります。`
  }
  return `別件のようです。/clear で新しく始めると、以降の読み直し（約 ${tokens} tok）がなくなります（今の回答も消えるので、残したい内容は先に /tokenomics handoff でメモを）。`
}

/**
 * The same suggestion, shortened to fit in the cat card, where it takes the place of the cat's phrase (about 34 cells
 * across at the narrowest card). It says the moment and the way out; the figures that `nudgeLine` adds are the pane's.
 */
export const nudgeShort = (c: Candidate, isSubscription: boolean, costMilliUsd: number | null = null): string => {
  const tokens = formatTokens(c.ctx)
  if (c.measure === 'C2') {
    return c.tag === 'strong'
      ? `かなり重くなっています（毎回 約${tokens} tok を読み直し）。/compact か、別件なら /clear を。`
      : `重くなってきました（毎回 約${tokens} tok を読み直し）。区切りで /compact を。`
  }
  if (c.measure === 'C3') {
    return `空いたため会話全体（約${tokens} tok）を読み直しました${dollars(costMilliUsd, isSubscription)}。別件なら /clear が一番軽いです。`
  }
  return `別件のようです。/clear で約${tokens} tok の読み直しがなくなります（今の回答は消えます）。`
}

/** What `/tokenomics nudge-test` shows, so the line can be seen on screen without waiting for a real moment. */
export const DEMO_LINE = 'これは提案の表示テストです。実際の提案も、返信のあとにこの形で一行出ます（何も入力されません）。'

/** The test line for the cat card (`hud` on), where the suggestion replaces the cat's phrase. */
export const DEMO_SHORT = 'これは提案の表示テストです。実際の提案も、ここに出ます（何も入力されません）。'
