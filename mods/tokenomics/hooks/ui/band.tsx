import type { Facts } from '../../types'
import { type Advice, THRESHOLDS, contextLevel, scaledPercent } from '../lib/advice'
import { CAT_COLS, CAT_ROWS } from '../lib/cat'
import { bar, formatTokens, formatUsd, limitLabel } from '../lib/format'
import { gaugeCells } from '../lib/gauge'
import { FACE, FACE_CELLS, FACE_STYLE, moodOf } from '../lib/mascot'
import type { Offer } from '../lib/offers'

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
  onDetails: () => void
  onAccept: () => void
  onLater: () => void
  onMute: () => void
  onLaterAdvice: (id: string) => void
}

/**
 * Narrower than this, the cat and the numbers do not fit side by side: the band is one plain row. The card needs
 * its frame and padding (4), the cat (16), a gap (2) and the widest row, the gauge with its label and percent (32):
 * 54 in all. A pane docked beside the transcript leaves the band about 56 on a terminal of 110 columns, so it is no more.
 */
export const CARD_MIN_COLUMNS = 56

/** The card is its frame and the cat's four rows. */
export const CARD_ROWS = CAT_ROWS + 2
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

/** The figures of a turn and of the account, beside the context: dollars and limits only once they matter. */
const figures = (ui: Ui, f: Facts) => {
  const { Box, Text } = ui
  const showCost = f.rateLimits.length === 0 && f.costUsd !== null && f.costUsd >= 1
  const limits = f.rateLimits.filter(r => r.percentUsed >= THRESHOLDS.limitNotice)
  const rows = [
    <Box gap={1}>
      <Text dimColor>今回</Text>
      <Text>{f.last === null ? '—' : `${formatTokens(f.last.spent)} tok`}</Text>
    </Box>,
  ]
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

type PartProps = BandProps & { advice: Advice | null }

/** The framed card: the cat on the left, the gauge and the figures to its right. */
const Card = (p: PartProps & { Raster: RasterElement }) => {
  const { Box, Text, Button } = p.ui
  const { Raster, Image } = p
  const f = p.facts
  const percent = f.contextPercent ?? 0
  const level = contextLevel(scaledPercent(f))
  const gaugeColumns = p.columns >= 90 ? 20 : 14

  return (
    <Box borderStyle="round" borderColor={levelColor(level) ?? 'claude'} paddingX={1} gap={2}>
      {Image !== null && p.cat.png !== null ? (
        <Image key="cat" source={{ png: p.cat.png }} columns={CAT_COLS} rows={CAT_ROWS} alt=" " />
      ) : (
        <Raster key="cat" columns={CAT_COLS} rows={CAT_ROWS} cells={p.cat.cells} />
      )}
      <Box flexDirection="column" flexGrow={1}>
        <Box gap={1}>
          <Text dimColor>コンテキスト</Text>
          <Raster key="gauge" columns={gaugeColumns} rows={1} cells={gaugeCells(percent, gaugeColumns)} />
          <Text bold color={levelColor(level)}>
            {percent}%
          </Text>
        </Box>
        <Box gap={2} flexWrap="wrap">
          {figures(p.ui, f)}
        </Box>
        {p.advice === null ? (
          <Text dimColor>{p.cat.phrase}</Text>
        ) : (
          <Box gap={2} flexWrap="wrap">
            <Text bold color={p.advice.level === 'warn' ? 'error' : 'warning'}>
              {p.advice.title}
            </Text>
            <Button key="later" label="あとで" dimColor onPress={() => p.onLaterAdvice(p.advice?.id ?? '')} />
          </Box>
        )}
        <Box gap={2} flexWrap="wrap">
          <Button key="details" label="詳しく" onPress={p.onDetails} />
          {p.tag !== null && <Text dimColor>{p.tag}</Text>}
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
  const percent = f.contextPercent ?? 0
  const face = FACE_STYLE[p.mood]

  return (
    <Box flexDirection="column">
      <Box gap={2} flexWrap="wrap">
        <Box width={FACE_CELLS}>
          <Text color={face.color} dimColor={face.dimColor}>
            {FACE[p.mood]}
          </Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>コンテキスト</Text>
          <Text color={levelColor(contextLevel(scaledPercent(f)))}>
            {bar(percent, isNarrow ? 6 : 10)} {percent}%
          </Text>
        </Box>
        {figures(p.ui, f)}
        {p.tag !== null && <Text dimColor>{p.tag}</Text>}
        <Button key="details" label="詳しく" onPress={p.onDetails} />
      </Box>
      {p.advice !== null && (
        <Box gap={2} flexWrap="wrap" marginLeft={isNarrow ? 0 : FACE_CELLS + 2}>
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
  const mood = moodOf(p.facts, card ?? advice, p.isCompacting)
  const part = { ...p, advice }
  const { Box } = p.ui
  // The card of the cat is tall: where it, and a suggestion above it, would not fit the room, the plain row goes under the suggestion.
  const room = p.maxRows - (card !== null ? OFFER_CARD_ROWS : 0)
  const hasRoomForCard = p.Raster !== null && p.columns >= CARD_MIN_COLUMNS && room >= CARD_ROWS

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
