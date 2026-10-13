import type { RenderChildren } from 'claude-code'

import type { Facts } from '../../types'
import { formatTokens } from '../lib/format'
import {
  WINDOW_NOTE,
  WINDOW_RECOMMENDED,
  type WindowView,
  currentLine,
  pickLines,
  pickOf,
  rulerOf,
  stepPick,
} from '../lib/window'

import type { Ui } from './ui'

export type WindowPickerProps = {
  ui: Ui
  /** The terminal draws the stops as a track of one-glyph buttons; the desktop as a row of labelled ones. */
  isTerminal: boolean
  facts: Facts
  view: WindowView
  /** The size the person stepped to, or null while they have not (the recommended one stands). */
  asked: number | null
  /** The mod is setting the size. */
  isBusy: boolean
  onPick: (tokens: number) => void
  onApply: (tokens: number) => void
  onReset: () => void
}

/** The cells between two stops of the track: a connector of two, so a stop sits every three. */
export const STOP_SPACING = 3

const LABEL_CELLS = 14

/**
 * The auto-compact size as a slider: a track of stops from 100k to 1M with the thumb on the one chosen, which starts on the
 * recommended size, and under it what that size comes to. The engine has no slider element, so the stops are buttons and
 * stepping is ◀ ▶.
 */
export const WindowPicker = (p: WindowPickerProps) => {
  const { Box, Text, Button } = p.ui
  const v = p.view
  const pick = pickOf(v, p.asked)
  const isDollars = p.facts.rateLimits.length === 0
  const lines = pickLines(v, pick)
  const what = isDollars ? '費用の目安' : '使用量の目安'

  const glyph = (tokens: number): { mark: string; color?: string; dim: boolean } => {
    if (tokens === pick) return { mark: '●', color: 'claude', dim: false }
    if (tokens === WINDOW_RECOMMENDED) return { mark: '★', color: 'warning', dim: false }
    if (tokens === v.current) return { mark: '◆', color: 'success', dim: false }
    return { mark: '○', dim: true }
  }

  const track: RenderChildren[] = []
  v.stops.forEach((s, i) => {
    if (i > 0) track.push(<Text dimColor>──</Text>)
    const g = glyph(s.tokens)
    track.push(
      <Button key={`window-stop-${s.tokens}`} label={formatTokens(s.tokens)} plain onPress={() => p.onPick(s.tokens)}>
        <Text color={g.color as never} dimColor={g.dim} bold={s.tokens === pick}>
          {g.mark}
        </Text>
      </Button>,
    )
  })

  return (
    <Box flexDirection="column">
      <Text bold color="claude">
        自動要約のタイミング
      </Text>
      <Text dimColor>会話が育つほど、返信のたびに全体を読み直すぶん高くなります。早めに要約するほど、その先が安くなります。</Text>
      <Text dimColor>数字は /autocompact に渡す大きさです。要約は、その約 3.3 万 tok 手前で始まります。</Text>
      <Text>{currentLine(v, isDollars)}</Text>

      {!v.isOff && (
        <Box flexDirection="column" marginTop={1}>
          {p.isTerminal ? (
            <Box flexDirection="column">
              <Box>{track}</Box>
              <Text dimColor>{rulerOf(v, STOP_SPACING)}</Text>
              <Text dimColor>● えらんだ　★ 300k（おすすめ）　◆ いま</Text>
            </Box>
          ) : (
            <Box gap={1} flexWrap="wrap">
              {v.stops.map(s => (
                <Button
                  key={`window-stop-${s.tokens}`}
                  label={`${s.tokens === pick ? '● ' : s.tokens === WINDOW_RECOMMENDED ? '★ ' : ''}${formatTokens(s.tokens)}`}
                  variant={s.tokens === pick ? 'primary' : undefined}
                  onPress={() => p.onPick(s.tokens)}
                />
              ))}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Box gap={2}>
              <Text bold>{lines.title}</Text>
              {lines.isRecommended && <Text color="warning">★ おすすめ</Text>}
              {lines.isCurrent && <Text color="success">いまの設定</Text>}
            </Box>
            <Box gap={2}>
              <Box width={LABEL_CELLS}>
                <Text dimColor>{what}</Text>
              </Box>
              <Text>{lines.againstStandard}</Text>
            </Box>
            <Box gap={2}>
              <Box width={LABEL_CELLS} />
              <Text>{lines.againstNow}</Text>
            </Box>
            <Box gap={2}>
              <Box width={LABEL_CELLS}>
                <Text dimColor>要約が始まる</Text>
              </Box>
              <Text>{lines.starts}</Text>
            </Box>
            <Box gap={2}>
              <Box width={LABEL_CELLS}>
                <Text dimColor>要約の回数</Text>
              </Box>
              <Text>{lines.times}</Text>
            </Box>
            {lines.reason !== '' && <Text dimColor>{lines.reason}</Text>}
          </Box>

          <Box marginTop={1}>
            {p.isBusy ? (
              <Text dimColor>設定しています…</Text>
            ) : (
              <Box gap={1} flexWrap="wrap">
                <Button key="window-less" label="◀ 小さく" onPress={() => p.onPick(stepPick(v, pick, -1))} />
                <Button key="window-more" label="大きく ▶" onPress={() => p.onPick(stepPick(v, pick, 1))} />
                {!lines.isCurrent && (
                  <Button
                    key="window-apply"
                    label={`${lines.title} にする${lines.isRecommended ? '（おすすめ）' : ''}`}
                    variant="primary"
                    onPress={() => p.onApply(pick)}
                  />
                )}
                {v.current < v.standard && <Button key="window-reset" label="標準に戻す" dimColor onPress={p.onReset} />}
              </Box>
            )}
          </Box>
          {v.isOwned && <Text dimColor>環境変数や管理者の設定で決まっているため、ここで変えても反映されないことがあります。</Text>}
          <Text dimColor>{WINDOW_NOTE}</Text>
        </Box>
      )}
    </Box>
  )
}
