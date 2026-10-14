import type { Facts, TurnTokens } from '../../types'
import { type Advice, THRESHOLDS, contextLevel, scaledPercent } from '../lib/advice'
import { CAT_COLS, CAT_ROWS } from '../lib/cat'
import { HEAVY_NOTICE_TOKENS } from '../lib/core/economics'
import { bar, cellWidth, formatTokens, formatUsd, limitLabel, promptTokens, promptsOf, wrappedRows } from '../lib/format'
import { fillOf, fillTokens, gaugeCells } from '../lib/gauge'
import { FACE, FACE_CELLS, FACE_STYLE, moodOf } from '../lib/mascot'
import type { Offer } from '../lib/offers'
import { stakeOf } from '../lib/stake'

import { OfferView } from './offer'
import type { ImageElement, RasterElement, Ui } from './ui'

export type BandProps = {
  ui: Ui
  /** The terminal's cell grid, where the surface has one; without it the band is one plain row. */
  Raster: RasterElement | null
  /** The terminal's picture element, when the cat is to be drawn as a picture; null draws it in cells. */
  Image: ImageElement | null
  facts: Facts
  /** The cat as it stands now, packed for a `Raster` and as a PNG (base64) for an `Image`, and what it is up to in a line. */
  cat: { cells: string; png: string | null; phrase: string }
  /** Something worth telling, with nothing to press, or null. */
  advice: Advice | null
  /**
   * The one-line suggestion made after the last reply, or null. In the card it takes the place of the cat's phrase; in
   * the plain row it is a row of its own. A suggestion's card hides it, and the next prompt clears it.
   */
  nudge: string | null
  /**
   * Tokens the output digest kept out of the conversation today, over every session on this machine (the pane's
   * "今日の節約"); the band says so only once it is more than none.
   */
  savedTokens: number
  /**
   * Tokens of reading that work handed to the plugin's skills and agents kept out of the conversation today: an estimate, said
   * apart from `savedTokens` and never added to it. 0 for a person held back from the savings, and when nothing was handed over.
   */
  keptTokens: number
  /** A suggestion put in a card here, because no pane fits the terminal; null otherwise. */
  offer: Offer | null
  /** The mod is compacting at the person's request. */
  isCompacting: boolean
  /** A model turn is running: no suggestion is put to the person meanwhile. */
  isWorking: boolean
  /** What has been accepted that changes how Claude works, or null; the band says so while it is. */
  tag: string | null
  /** Cells the band has across. */
  columns: number
  /** Rows the band may take before it scrolls (in fullscreen, half the terminal less the prompt). */
  maxRows: number
  /** Shows the analysis pane, and the settings pane. */
  onAnalysis: () => void
  onSettings: () => void
  onAccept: () => void
  onLater: () => void
  onMute: () => void
  onLaterAdvice: (id: string) => void
}

/**
 * Narrower than this, the cat and the numbers do not fit side by side: the band is one plain row. The card needs
 * its frame and padding (4), the cat (16), a gap (2) and the widest row, the gauge (at least 6) with its label, percent
 * and tokens (34 in all, see `GAUGE_ROW_CELLS`): 56 in all. A pane docked beside the transcript leaves the band about 56
 * on a terminal of 110 columns, so it is no more.
 */
export const CARD_MIN_COLUMNS = 56

/** The card is its frame and the cat's four rows. */
export const CARD_ROWS = CAT_ROWS + 2

/** What the card takes beside its right column: the frame and padding (4), the cat (16) and the gap between (2). */
const CARD_SIDE_CELLS = 4 + CAT_COLS + 2

/**
 * What the gauge's row takes besides the gauge: the label (12), the percent at its widest ("100%", 4), the tokens at their
 * widest ("999k/999k", 9) and the three gaps between the four. Reserved at full size, so the gauge does not change length as the numbers do.
 */
const GAUGE_ROW_CELLS = 12 + 4 + 9 + 3
const GAUGE_MIN_COLUMNS = 6

/** The gauge's length: the usual one, or what is left of the card's right column. */
const gaugeColumnsFor = (columns: number): number =>
  Math.max(GAUGE_MIN_COLUMNS, Math.min(columns >= 90 ? 20 : 14, columns - CARD_SIDE_CELLS - GAUGE_ROW_CELLS))

/**
 * Rows the card gains over the cat's four: its right column is the gauge's row (the figures, if any, stand beside the gauge), the
 * last turn's chips (two rows or more, a dash, one, before there is a turn; more where the column is too narrow for a row of
 * them), what is told beneath them and the buttons' row. What is told is a suggestion, which may wrap in the column, with advice
 * under it if there is any, or advice alone; with neither, the cat's phrase stands beside the buttons and takes no row.
 */
export const cardExtraRows = (nudge: string | null, hasAdvice: boolean, columns: number, turn: TurnTokens | null = null): number => {
  const told = nudge === null ? (hasAdvice ? 1 : 0) : wrappedRows(nudge, columns - CARD_SIDE_CELLS) + (hasAdvice ? 1 : 0)
  const chips = turn === null ? 1 : turnRows(turn, columns - CARD_SIDE_CELLS)
  return Math.max(0, 2 + chips + told - CAT_ROWS)
}

/**
 * What a suggestion's own card takes above the band: its frame, a title, a reason and what accepting does (each
 * may wrap) and its buttons. Counted generously, since a band taller than its room scrolls and could push
 * the answer to the suggestion out of sight.
 */
export const OFFER_CARD_ROWS = 8

const levelColor = (level: 'ok' | 'notice' | 'warn'): 'warning' | 'error' | undefined =>
  level === 'warn' ? 'error' : level === 'notice' ? 'warning' : undefined

/** Below this, what agents spent is not worth a word in the band (it is always in the pane). */
const AGENT_CHIP_TOKENS = 1_000

type Chip = { label: string; value: string }

const tok = (n: number): string => `${formatTokens(n)} tok`

/**
 * The last turn as the API counted it, in two rows of chips: the prompt whole, the output and how many requests the turn made (the
 * figures are sums over them), then, under the prompt, what it was made of (the three kinds that are billed apart, which add up to it). Every kind is named in full and every count carries its unit.
 * The first chip says what the figures are a total of ("1ターンの合計", or so far); only where that makes the first row wrap and the bare
 * "今回" would not, in the `columns` cells it has, the chip is called "今回" alone (the pane says the rest).
 */
const turnChips = (t: TurnTokens, isRunning = false, columns?: number): Chip[][] => {
  const first = (label: string): Chip[] => [
    { label, value: `入力 ${tok(promptTokens(t))}` },
    { label: '出力', value: tok(t.output) },
    ...(promptsOf(t).length > 0 ? [{ label: 'リクエスト', value: `${promptsOf(t).length} 回` }] : []),
  ]
  const full = first(isRunning ? '今回（途中の合計）' : '今回（1ターンの合計）')
  const short = first('今回')
  return [
    columns !== undefined && flowRows(full, columns) > flowRows(short, columns) ? short : full,
    [
      { label: '└ キャッシュ読み', value: tok(t.cacheRead) },
      { label: 'キャッシュ書き込み', value: tok(t.cacheWrite) },
      { label: 'キャッシュなし', value: tok(t.input) },
    ],
  ]
}

const CHIP_GAP = 2

const chipCells = (c: Chip): number => cellWidth(c.label) + 1 + cellWidth(c.value)

/** Rows a row of chips takes in `columns` cells: a chip that does not fit goes to the next row. */
const flowRows = (chips: Chip[], columns: number): number => {
  let rows = 1
  let used = 0
  for (const chip of chips) {
    const cells = chipCells(chip)
    if (used === 0) used = cells
    else if (used + CHIP_GAP + cells <= columns) used += CHIP_GAP + cells
    else {
      rows += 1
      used = cells
    }
  }
  return rows
}

/** Rows the last turn's chips take in `columns` cells. */
const turnRows = (t: TurnTokens, columns: number, isRunning = false): number => turnChips(t, isRunning, columns).reduce((sum, row) => sum + flowRows(row, columns), 0)

/** The last turn in the band: the chips above, or a dash before there has been one. */
const TurnBlock = (p: { ui: Ui; turn: TurnTokens | null; isRunning: boolean; columns?: number }) => {
  const { Box, Text } = p.ui
  if (p.turn === null) {
    return (
      <Box gap={1}>
        <Text dimColor>今回</Text>
        <Text>—</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {turnChips(p.turn, p.isRunning, p.columns).map(row => (
        <Box key={row[0]?.label} columnGap={CHIP_GAP} flexWrap="wrap">
          {row.map(chip => (
            <Box key={chip.label} gap={1}>
              <Text dimColor>{chip.label}</Text>
              <Text>{chip.value}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** The figures of a turn and of the account, beside the context: savings, dollars and limits only once they matter. */
const figures = (ui: Ui, f: Facts, savedTokens: number, keptTokens: number) => {
  const { Box, Text } = ui
  const showCost = f.rateLimits.length === 0 && f.costUsd !== null && f.costUsd >= 1
  const limits = f.rateLimits.filter(r => r.percentUsed >= THRESHOLDS.limitNotice)
  const rows: ReturnType<typeof Box>[] = []
  // What agents spent for this turn is spent all the same, though the turn's own figure leaves it out.
  if (f.agentTokensThisTurn >= AGENT_CHIP_TOKENS) {
    rows.push(
      <Box gap={1}>
        <Text dimColor>エージェント</Text>
        <Text>{formatTokens(f.agentTokensThisTurn)} tok</Text>
      </Box>,
    )
  }
  // What every request carries, once a summary would make a difference to it.
  const stake = stakeOf(f)
  if (stake !== null && stake.isWorthSaying) {
    rows.push(
      <Box gap={1}>
        <Text dimColor>毎回</Text>
        <Text color={stake.tokens >= HEAVY_NOTICE_TOKENS ? 'warning' : undefined}>{`${formatTokens(stake.tokens)} tok を読み直し`}</Text>
      </Box>,
    )
  }
  if (savedTokens > 0) {
    rows.push(
      <Box gap={1}>
        <Text dimColor>節約</Text>
        <Text color="success">{`約 ${formatTokens(savedTokens)} tok`}</Text>
      </Box>,
    )
  }
  if (keptTokens > 0) {
    rows.push(
      <Box gap={1}>
        <Text dimColor>委任（推定）</Text>
        <Text color="success">{`約 ${formatTokens(keptTokens)} tok`}</Text>
      </Box>,
    )
  }
  if (showCost) {
    rows.push(
      <Box gap={1}>
        <Text dimColor>累計</Text>
        <Text>{formatUsd(f.costUsd ?? 0)}</Text>
      </Box>,
    )
  }
  for (const limit of limits) {
    rows.push(
      <Box gap={1}>
        <Text dimColor>{limitLabel(limit.kind)}の上限</Text>
        <Text color={limit.percentUsed >= THRESHOLDS.limitWarn ? 'error' : 'warning'}>{Math.floor(limit.percentUsed)}%</Text>
      </Box>,
    )
  }
  return rows
}

type PartProps = BandProps & { advice: Advice | null; nudge: string | null }

/**
 * The turn shown is the running one, summed over the requests it has had so far. The engine says a turn is running; the facts say
 * the figures are that turn's. (The label is shorter than the finished turn's, so the room counted for the longer one holds.)
 */
const isRunning = (p: PartProps): boolean => p.isWorking && p.facts.isLastRunning === true

/** The framed card: the cat on the left, the gauge and the figures to its right. */
const Card = (p: PartProps & { Raster: RasterElement }) => {
  const { Box, Text, Button } = p.ui
  const { Raster, Image } = p
  const f = p.facts
  const fill = fillOf(f)
  const tokens = fillTokens(fill)
  const level = contextLevel(scaledPercent(f))
  const gaugeColumns = gaugeColumnsFor(p.columns)
  const others = figures(p.ui, f, p.savedTokens, p.keptTokens)

  return (
    <Box borderStyle="round" borderColor={levelColor(level) ?? 'claude'} paddingX={1} gap={2}>
      {Image !== null && p.cat.png !== null ? (
        <Image key="cat" source={{ png: p.cat.png }} columns={CAT_COLS} rows={CAT_ROWS} alt=" " />
      ) : (
        <Raster key="cat" columns={CAT_COLS} rows={CAT_ROWS} cells={p.cat.cells} />
      )}
      <Box flexDirection="column" flexGrow={1}>
        <Box columnGap={2} flexWrap="wrap">
          <Box gap={1}>
            <Text dimColor>コンテキスト</Text>
            <Raster key="gauge" columns={gaugeColumns} rows={1} cells={gaugeCells(fill.percent, gaugeColumns)} />
            <Text bold color={levelColor(level)}>
              {fill.percent}%
            </Text>
            {tokens !== null && <Text>{tokens}</Text>}
          </Box>
          {others}
        </Box>
        <TurnBlock ui={p.ui} turn={f.last} isRunning={isRunning(p)} columns={p.columns - CARD_SIDE_CELLS} />
        {p.nudge !== null && <Text color="claude">{p.nudge}</Text>}
        {p.advice !== null && (
          <Box columnGap={2} flexWrap="wrap">
            <Text bold color={p.advice.level === 'warn' ? 'error' : 'warning'}>
              {p.advice.title}
            </Text>
            <Button key="later" label="あとで" dimColor onPress={() => p.onLaterAdvice(p.advice?.id ?? '')} />
          </Box>
        )}
        <Box columnGap={2} flexWrap="wrap">
          <Button key="analysis" label="詳しく分析" onPress={p.onAnalysis} />
          <Button key="settings" label="設定" onPress={p.onSettings} />
          {p.tag !== null && <Text dimColor>{p.tag}</Text>}
          {p.nudge === null && p.advice === null && <Text dimColor>{p.cat.phrase}</Text>}
        </Box>
      </Box>
    </Box>
  )
}

/** One row: the cat's face, the fill and the last turn's tokens; where there is no picture, or no room for one. */
const Plain = (p: PartProps & { mood: ReturnType<typeof moodOf> }) => {
  const { Box, Text, Button } = p.ui
  const f = p.facts
  const isNarrow = p.columns < 56
  const fill = fillOf(f)
  const tokens = fillTokens(fill)
  const face = FACE_STYLE[p.mood]

  return (
    <Box flexDirection="column">
      <Box columnGap={2} flexWrap="wrap">
        <Box width={FACE_CELLS}>
          <Text color={face.color} dimColor={face.dimColor}>
            {FACE[p.mood]}
          </Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>コンテキスト</Text>
          <Text color={levelColor(contextLevel(scaledPercent(f)))}>
            {bar(fill.percent, isNarrow ? 6 : 10)} {fill.percent}%
          </Text>
          {tokens !== null && <Text>{tokens}</Text>}
        </Box>
        <TurnBlock ui={p.ui} turn={f.last} isRunning={isRunning(p)} />
        {figures(p.ui, f, p.savedTokens, p.keptTokens)}
        {p.tag !== null && <Text dimColor>{p.tag}</Text>}
        <Button key="analysis" label="詳しく分析" onPress={p.onAnalysis} />
        <Button key="settings" label="設定" onPress={p.onSettings} />
      </Box>
      {p.nudge !== null && (
        <Box marginLeft={isNarrow ? 0 : FACE_CELLS + 2}>
          <Text color="claude">{p.nudge}</Text>
        </Box>
      )}
      {p.advice !== null && (
        <Box columnGap={2} flexWrap="wrap" marginLeft={isNarrow ? 0 : FACE_CELLS + 2}>
          <Text color={p.advice.level === 'warn' ? 'error' : 'warning'}>{p.advice.title}</Text>
          <Button key="later" label="あとで" dimColor onPress={() => p.onLaterAdvice(p.advice?.id ?? '')} />
        </Box>
      )}
    </Box>
  )
}

/**
 * The band above the prompt. On a terminal wide enough: a framed card with the running cat and a gauge.
 * Otherwise one plain row. Either way the context fill and the last turn's tokens are always there, and
 * dollars and limits join them only once they matter. A suggestion that no pane could seat stands above
 * it as a card of its own.
 */
export const Band = (p: BandProps) => {
  const card = p.isWorking ? null : p.offer
  const advice = card === null ? p.advice : null
  // A suggestion's card is asked about first, and nothing is put to the person while a turn runs: the one-line
  // suggestion waits (the caller keeps it) until the card is closed and the turn is over.
  const nudge = card === null && !p.isWorking ? (p.nudge ?? null) : null
  const mood = moodOf(p.facts, card ?? advice, p.isCompacting)
  const part = { ...p, advice, nudge }
  const { Box } = p.ui
  // The card of the cat is tall: where it, and a suggestion above it, would not fit the room, the plain row goes under the suggestion.
  // A one-line suggestion that wraps makes the card taller still, and then the plain row is the safer fit.
  const room = p.maxRows - (card !== null ? OFFER_CARD_ROWS : 0)
  const hasRoomForCard =
    p.Raster !== null && p.columns >= CARD_MIN_COLUMNS && room >= CARD_ROWS + cardExtraRows(nudge, advice !== null, p.columns, p.facts.last)

  return (
    <Box flexDirection="column">
      {card !== null && (
        <OfferView
          ui={p.ui}
          offer={card}
          keyBase="offer-"
          isCard
          isBusy={p.isCompacting}
          hasLater
          onAccept={p.onAccept}
          onLater={p.onLater}
          onMute={p.onMute}
        />
      )}
      {hasRoomForCard && p.Raster !== null ? <Card {...part} Raster={p.Raster} /> : <Plain {...part} mood={mood} />}
    </Box>
  )
}
