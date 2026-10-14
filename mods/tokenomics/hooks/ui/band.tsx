import type { Facts, SessionTotals, TurnTokens } from '../../types'
import { type Advice, THRESHOLDS, contextLevel, scaledPercent } from '../lib/advice'
import { CAT_COLS, CAT_ROWS } from '../lib/cat'
import { liveSessionOf } from '../lib/facts'
import { bar, cellWidth, formatTokens, formatUsd, limitLabel, promptTokens, promptsOf, wrappedRows } from '../lib/format'
import { fillOf, fillTokens, gaugeCells } from '../lib/gauge'
import { FACE, FACE_CELLS, FACE_STYLE, moodOf } from '../lib/mascot'
import type { Offer } from '../lib/offers'

import { OfferView } from './offer'
import type { ImageElement, RasterElement, Ui } from './ui'

export type BandProps = {
  ui: Ui
  /** The terminal's cell grid, where the surface has one; without it the band is one plain row. */
  Raster: RasterElement | null
  /** The terminal's picture element, when Clawd is to be drawn as a picture; null draws it in cells. */
  Image: ImageElement | null
  facts: Facts
  /** Clawd as it stands now, packed for a `Raster` and as a PNG (base64) for an `Image`, and what it is up to in a line. */
  cat: { cells: string; png: string | null; phrase: string }
  /** Something worth telling, with nothing to press, or null. */
  advice: Advice | null
  /**
   * The one-line suggestion made after the last reply, or null. In the card it takes the place of Clawd's phrase; in
   * the plain row it is a row of its own. A suggestion's card hides it, and the next prompt clears it.
   */
  nudge: string | null
  /**
   * Tokens the savings layer kept out in this session (since it began or was last cleared), all kinds added up in one figure: the
   * output digest's cuts and the reading handed to the plugin's skills and agents (an estimate), each counted over the requests it
   * spared, and the outputs cut inside subagents. The session's row always says it as "節約（延べ）" ("0 tok" while it is none); the pane
   * says the kinds apart and the day's figure. 0 for a person held back from the savings.
   */
  savedTokens: number
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
 * Narrower than this, Clawd and the numbers do not fit side by side: the band is one plain row. The card needs
 * its frame and padding (4), Clawd (16), a gap (2) and the widest row, the gauge (at least 6) with its label, percent
 * and tokens (34 in all, see `GAUGE_ROW_CELLS`): 56 in all. A pane docked beside the transcript leaves the band about 56
 * on a terminal of 110 columns, so it is no more.
 */
export const CARD_MIN_COLUMNS = 56

/** The card is its frame and Clawd's five rows. */
export const CARD_ROWS = CAT_ROWS + 2

/** What the card takes beside its right column: the frame and padding (4), Clawd (16) and the gap between (2). */
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
 * Rows the card gains over Clawd's five: its right column is the gauge's row (the figures, if any, stand beside the gauge), the
 * session's chips (`sessionRows`, one row or more), the last turn's chips (two rows or more, a dash, one, before there is a turn; more
 * where the column is too narrow for a row of them), what is told beneath them and the buttons' row. What is told is a suggestion,
 * which may wrap in the column, with advice under it if there is any, or advice alone; with neither, Clawd's phrase stands beside
 * the buttons and takes no row.
 */
export const cardExtraRows = (
  nudge: string | null,
  hasAdvice: boolean,
  columns: number,
  turn: TurnTokens | null = null,
  sessionRows = 1,
): number => {
  const told = nudge === null ? (hasAdvice ? 1 : 0) : wrappedRows(nudge, columns - CARD_SIDE_CELLS) + (hasAdvice ? 1 : 0)
  const chips = turn === null ? 1 : turnRows(turn, columns - CARD_SIDE_CELLS)
  return Math.max(0, 2 + sessionRows + chips + told - CAT_ROWS)
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

type Chip = { label: string; value: string; color?: 'success' }

const tok = (n: number): string => `${formatTokens(n)} tok`

/**
 * A row of chips whose first chip names what the figures are a total of: the full name, or the short one only where that makes the
 * row wrap and the short one would not, in the `columns` cells it has (the pane says the rest).
 */
const named = (chips: (label: string) => Chip[], full: string, short: string, columns?: number): Chip[] => {
  const long = chips(full)
  if (columns === undefined) return long
  const bare = chips(short)

  return flowRows(long, columns) > flowRows(bare, columns) ? bare : long
}

/**
 * The last turn as the API counted it, in two rows of chips: the prompt whole, the output and how many requests the turn made (the
 * figures are sums over them), then, under the prompt, what it was made of (the three kinds that are billed apart, which add up to it). Every kind is named in full and every count carries its unit.
 * The first chip says what the figures are a total of, "現在のターンの合計", whether the turn is under way (a total so far) or over; only where that makes the first row wrap and the bare
 * "今回" would not, in the `columns` cells it has, the chip is called "今回" alone (the pane says the rest).
 */
const turnChips = (t: TurnTokens, columns?: number): Chip[][] => {
  const first = (label: string): Chip[] => [
    { label, value: `入力 ${tok(promptTokens(t))}` },
    { label: '出力', value: tok(t.output) },
    ...(promptsOf(t).length > 0 ? [{ label: 'リクエスト', value: `${promptsOf(t).length} 回` }] : []),
  ]
  return [
    named(first, '現在のターンの合計', '今回', columns),
    [
      { label: '└ キャッシュ読み', value: tok(t.cacheRead) },
      { label: 'キャッシュ書き込み', value: tok(t.cacheWrite) },
      { label: 'キャッシュなし', value: tok(t.input) },
    ],
  ]
}

/**
 * The session so far, in one row of chips, below the context: the prompt whole, the output, the requests and the turns (sums over
 * the turns, the one under way included) and what the savings layer has spared the requests ("節約（延べ）", all kinds added up; "0 tok"
 * until something is kept out, and in green once it is). The requests are named only where every turn had them counted; before a turn is counted a dash stands for them.
 * The first chip says what the figures are a total of, "現在のセッションの合計", or "セッション" alone where that saves the row a wrap.
 */
const sessionChips = (s: SessionTotals, savedTokens: number, columns?: number): Chip[] => {
  const saved: Chip =
    savedTokens > 0 ? { label: '節約（延べ）', value: `約 ${formatTokens(savedTokens)} tok`, color: 'success' } : { label: '節約（延べ）', value: '0 tok' }
  const row = (label: string): Chip[] =>
    s.turns === 0
      ? [{ label, value: '—' }, saved]
      : [
          { label, value: `入力 ${tok(s.input + s.cacheWrite + s.cacheRead)}` },
          { label: '出力', value: tok(s.output) },
          ...(s.requestTurns === s.turns ? [{ label: 'リクエスト', value: `${s.requests} 回` }] : []),
          { label: 'ターン', value: `${s.turns} 回` },
          saved,
        ]

  return named(row, '現在のセッションの合計', 'セッション', columns)
}

const CHIP_GAP = 2

const chipCells = (c: Chip): number => cellWidth(c.label) + 1 + cellWidth(c.value)

/** Rows a row of chips takes in `columns` cells: a chip that does not fit goes to the next row, and one wider than the row wraps itself. */
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
    if (cells > columns && columns > 0) {
      rows += Math.ceil(cells / columns) - 1
      used = columns
    }
  }
  return rows
}

/** Rows the last turn's chips take in `columns` cells. */
const turnRows = (t: TurnTokens, columns: number): number => turnChips(t, columns).reduce((sum, row) => sum + flowRows(row, columns), 0)

/** A row of chips: each a dim name and its figure, wrapping where the row is too narrow. */
const ChipRow = (p: { ui: Ui; chips: Chip[] }) => {
  const { Box, Text } = p.ui
  return (
    <Box columnGap={CHIP_GAP} flexWrap="wrap">
      {p.chips.map(chip => (
        <Box key={chip.label} gap={1}>
          <Text dimColor>{chip.label}</Text>
          <Text color={chip.color}>{chip.value}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** The last turn in the band: the chips above, or a dash before there has been one. */
const TurnBlock = (p: { ui: Ui; turn: TurnTokens | null; columns?: number }) => {
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
      {turnChips(p.turn, p.columns).map(row => (
        <ChipRow key={row[0]?.label} ui={p.ui} chips={row} />
      ))}
    </Box>
  )
}

/** The session so far, below the context. */
const SessionBlock = (p: { ui: Ui; facts: Facts; savedTokens: number; columns?: number }) => (
  <ChipRow ui={p.ui} chips={sessionChips(liveSessionOf(p.facts), p.savedTokens, p.columns)} />
)

/** Rows the session's chips take in `columns` cells. */
const sessionRowsOf = (f: Facts, savedTokens: number, columns: number): number => flowRows(sessionChips(liveSessionOf(f), savedTokens, columns), columns)

/** The figures of the account, beside the context: dollars and limits only once they matter, and what agents spent. */
const figures = (ui: Ui, f: Facts) => {
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

/** The framed card: Clawd on the left, the gauge and the figures to its right. */
const Card = (p: PartProps & { Raster: RasterElement }) => {
  const { Box, Text, Button } = p.ui
  const { Raster, Image } = p
  const f = p.facts
  const fill = fillOf(f)
  const tokens = fillTokens(fill)
  const level = contextLevel(scaledPercent(f))
  const gaugeColumns = gaugeColumnsFor(p.columns)
  const others = figures(p.ui, f)

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
        <SessionBlock ui={p.ui} facts={f} savedTokens={p.savedTokens} columns={p.columns - CARD_SIDE_CELLS} />
        <TurnBlock ui={p.ui} turn={f.last} columns={p.columns - CARD_SIDE_CELLS} />
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

/** One row: Clawd's face, the fill and the last turn's tokens; where there is no picture, or no room for one. */
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
        <SessionBlock ui={p.ui} facts={f} savedTokens={p.savedTokens} />
        <TurnBlock ui={p.ui} turn={f.last} />
        {figures(p.ui, f)}
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
  // Clawd's card is tall: where it, and a suggestion above it, would not fit the room, the plain row goes under the suggestion.
  // A one-line suggestion that wraps makes the card taller still, and then the plain row is the safer fit.
  const room = p.maxRows - (card !== null ? OFFER_CARD_ROWS : 0)
  const hasRoomForCard =
    p.Raster !== null &&
    p.columns >= CARD_MIN_COLUMNS &&
    room >= CARD_ROWS + cardExtraRows(nudge, advice !== null, p.columns, p.facts.last, sessionRowsOf(p.facts, p.savedTokens, p.columns - CARD_SIDE_CELLS))

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
