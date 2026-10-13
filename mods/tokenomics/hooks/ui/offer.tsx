import { FACE, FACE_CELLS, FACE_STYLE, moodForLevel } from '../lib/mascot'
import type { Offer } from '../lib/offers'

import type { Ui } from './ui'

export type OfferViewProps = {
  ui: Ui
  offer: Offer
  /** Prefix of the buttons' keys, so several offers can stand in one tree. */
  keyBase: string
  /** A framed card above the band, where no pane fits; else the body of a dialog pane or a row of the pane's list. */
  isCard: boolean
  /** The mod is carrying out something for the person. */
  isBusy: boolean
  /** "あとで" means something only on the offer put to the person; in the pane's list the item simply stays. */
  hasLater: boolean
  onAccept: () => void
  onLater: () => void
  onMute: () => void
}

/**
 * One suggestion: what is the case, why it matters now, and what accepting does, with
 * the three answers beneath. The same tree is a dialog's body, a card, or an entry in the pane.
 */
export const OfferView = (p: OfferViewProps) => {
  const { Box, Text, Button } = p.ui
  const mood = moodForLevel(p.offer.level)
  const face = FACE_STYLE[mood]
  const color = p.offer.level === 'warn' ? 'error' : 'warning'

  const body = (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={face.color}>{FACE[mood]}</Text>
        <Text bold color={color}>
          {p.offer.title}
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={FACE_CELLS + 1}>
        <Text dimColor>{p.offer.why}</Text>
        <Text>{p.offer.does}</Text>
        {p.isBusy ? (
          <Text dimColor>{FACE.busy} 実行しています…</Text>
        ) : (
          <Box gap={1} flexWrap="wrap">
            <Button key={`${p.keyBase}accept`} label={p.offer.accept} variant="primary" onPress={p.onAccept} />
            {p.hasLater && (
              // Enter on a dialog that took the keys by itself should never carry something out.
              <Button key={`${p.keyBase}later`} label="あとで" autoFocus={p.isCard ? undefined : true} onPress={p.onLater} />
            )}
            <Button key={`${p.keyBase}mute`} label="もう出さない" dimColor onPress={p.onMute} />
          </Box>
        )}
      </Box>
    </Box>
  )

  return p.isCard ? (
    <Box borderStyle="round" borderColor={p.offer.level === 'warn' ? 'error' : 'claude'} paddingX={1}>
      {body}
    </Box>
  ) : (
    body
  )
}
