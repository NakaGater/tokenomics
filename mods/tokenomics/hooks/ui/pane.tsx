import type { Facts, HeavyItem, OfferKind, Savings } from '../../types'
import type { Advice } from '../lib/advice'
import { RECENT_REQUESTS, recentOf } from '../lib/facts'
import { formatTokens } from '../lib/format'
import { FACE, FACE_CELLS, FACE_STYLE, moodForLevel } from '../lib/mascot'
import type { ActiveSaving, SavingKey } from '../lib/modes'
import { OFFER_NAMES, type Offer } from '../lib/offers'
import type { Demo } from '../lib/pace'
import { NOTHING_TO_DO, statusRows } from '../lib/status'

import { OfferView } from './offer'
import { RequestChart } from './chart'
import type { RasterElement, Ui } from './ui'

export type PaneProps = {
  ui: Ui
  /** The terminal's grid of colored cells, or null where there is none. */
  Raster: RasterElement | null
  /** Cells across the pane's body. */
  bodyColumns: number
  facts: Facts
  /** Things worth knowing, with nothing to press. */
  advice: readonly Advice[]
  /** Suggestions that fit now and have not been muted: the pane is where one put off can still be taken up. */
  offers: readonly Offer[]
  /** What the savings layer has done today. */
  savings: Savings
  /** The context broken down, or null before it was asked for. */
  heavy: HeavyItem[] | null
  /** What was accepted and is still running. */
  active: readonly ActiveSaving[]
  /** Kinds of suggestion the person asked not to see again. */
  muted: readonly OfferKind[]
  isCompacting: boolean
  /** The band is drawing its cat, so the demonstration below has something to show. */
  hasCat: boolean
  /** Rows the pane has down. */
  rows: number
  onAccept: (offer: Offer) => void
  onMuteKind: (kind: OfferKind) => void
  onResume: (kind: OfferKind) => void
  onStop: (key: SavingKey) => void
  onRefresh: () => void
  onCat: (demo: Demo) => void
  onClose: () => void
}

const CAT_DEMOS: readonly { demo: Demo; label: string }[] = [
  { demo: 'sleep', label: '寝る' },
  { demo: 'walk', label: '歩く' },
  { demo: 'trot', label: '小走り' },
  { demo: 'run', label: '走る' },
  { demo: 'sprint', label: '全力' },
  { demo: 'sweat', label: '汗' },
  { demo: 'jump', label: 'ジャンプ' },
]

const TIPS = [
  '話題が変わったら /clear。新しく始めるのが一番軽くなります。',
  '同じ話題が長く続くなら /compact で要約。',
  'ファイルは全体ではなく、範囲を指定して読む。',
  'モデルは会話の途中で変えない（キャッシュが無駄になります）。',
  '使っていない MCP サーバーは /mcp で無効にできます。',
]

/** The label column of the status rows: the longest label ("このセッションの入力") and two cells of air. */
export const LABEL_CELLS = 22

/** Rows below which the tips are left out: what to do now matters more than the tips. */
const ROOM_FOR_TIPS = 40

const Heading = (p: { ui: Ui; children: string }) => {
  const { Text } = p.ui
  return (
    <Text bold color="claude">
      {p.children}
    </Text>
  )
}

export const Pane = (p: PaneProps) => {
  const { Box, Text, Button } = p.ui

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Heading ui={p.ui}>今やること</Heading>
        {p.offers.length === 0 && p.advice.length === 0 && (
          <Box gap={1}>
            <Text color={FACE_STYLE.good.color}>{FACE.good}</Text>
            <Text color="success">{NOTHING_TO_DO}</Text>
          </Box>
        )}
        {p.offers.map(offer => (
          <Box marginTop={1}>
            <OfferView
              ui={p.ui}
              offer={offer}
              keyBase={`standing-${offer.id}-`}
              isCard={false}
              isBusy={p.isCompacting}
              hasLater={false}
              onAccept={() => p.onAccept(offer)}
              onLater={() => undefined}
              onMute={() => p.onMuteKind(offer.kind)}
            />
          </Box>
        ))}
        {p.advice.map(a => (
          <Box flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text color={FACE_STYLE[moodForLevel(a.level)].color}>{FACE[moodForLevel(a.level)]}</Text>
              <Text color={a.level === 'warn' ? 'error' : 'warning'}>{a.title}</Text>
            </Box>
            <Box marginLeft={FACE_CELLS + 1}>
              <Text dimColor>{a.detail}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Heading ui={p.ui}>いまの状態</Heading>
        {statusRows(p.facts, p.savings)
          // The chart below says what the requests of the turn were, one by one.
          .filter(row => row.label !== '今回のリクエスト')
          .map(row => (
          <Box gap={2}>
            <Box width={LABEL_CELLS}>
              <Text dimColor>{row.label}</Text>
            </Box>
            <Text>{row.value}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Heading ui={p.ui}>{`直近 ${RECENT_REQUESTS} 回のリクエスト`}</Heading>
        <Text dimColor>本体の呼び出しだけ（サブエージェントは含みません）。ターンをまたいで、左が古く右が新しい。</Text>
        <RequestChart ui={p.ui} Raster={p.Raster} requests={recentOf(p.facts)} columns={p.bodyColumns} />
      </Box>

      <Box flexDirection="column">
        <Heading ui={p.ui}>いま効いている節約</Heading>
        {p.active.length === 0 && <Text dimColor>提案を受け入れると、ここに並びます。いつでもやめられます。</Text>}
        {p.active.map(saving => (
          <Box gap={2} flexWrap="wrap">
            <Text>{saving.label}</Text>
            <Button key={`stop-${saving.key}`} label={saving.stop} onPress={() => p.onStop(saving.key)} />
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Box gap={2}>
          <Heading ui={p.ui}>重いもの</Heading>
          <Button key="refresh" label={p.heavy === null ? '調べる' : '更新'} onPress={p.onRefresh} />
        </Box>
        {p.heavy === null && <Text dimColor>会話の中で何がどれだけ場所を取っているかを調べます。</Text>}
        {p.heavy?.map(item => (
          <Box flexDirection="column">
            <Box gap={2}>
              <Box width={24}>
                <Text>{item.name}</Text>
              </Box>
              <Text>{formatTokens(item.tokens)} tok</Text>
            </Box>
            {item.details?.map(line => (
              <Text dimColor>  ・{line}</Text>
            ))}
            {item.hint !== undefined && <Text dimColor>  → {item.hint}</Text>}
          </Box>
        ))}
      </Box>

      {p.hasCat && (
        <Box flexDirection="column">
          <Heading ui={p.ui}>ねこのようす</Heading>
          <Text dimColor>会話が重くなるほど、帯の猫は速く走ります。押すと、しばらくその様子を見られます。</Text>
          <Box gap={1} flexWrap="wrap">
            {CAT_DEMOS.map(item => (
              <Button key={`cat-${item.demo}`} label={item.label} onPress={() => p.onCat(item.demo)} />
            ))}
          </Box>
        </Box>
      )}

      {p.muted.length > 0 && (
        <Box flexDirection="column">
          <Heading ui={p.ui}>止めている提案</Heading>
          {p.muted.map(kind => (
            <Box gap={2} flexWrap="wrap">
              <Text>{OFFER_NAMES[kind]}</Text>
              <Button key={`resume-${kind}`} label="再開" onPress={() => p.onResume(kind)} />
            </Box>
          ))}
        </Box>
      )}

      {p.rows >= ROOM_FOR_TIPS && (
        <Box flexDirection="column">
          <Heading ui={p.ui}>節約のコツ</Heading>
          {TIPS.map(tip => (
            <Text dimColor>・{tip}</Text>
          ))}
        </Box>
      )}

      <Box>
        <Button key="close" label="閉じる" role="dismiss" onPress={p.onClose} />
      </Box>
    </Box>
  )
}
