import type { Facts } from '../../types'

import { type ContextLevel, contextLevel, scaledPercent } from './advice'

export type Mood = 'good' | 'heavy' | 'full' | 'busy'

// Clawd's face in text (arms, body, two eyes), for where the picture cannot go: a toast, the pane, a terminal too narrow for the
// card, the desktop. Only narrow characters (halfwidth marks, ASCII): `•` and `ω` are "ambiguous" and take two cells
// in terminals set for Japanese, which would push the whole row out of line.
export const FACE: Record<Mood, string> = {
  good: '<[･_･]>',
  heavy: '<[o_o]>',
  full: '<[>_<]>',
  busy: '<[-_-]>',
}

/** Cells of the widest face: the band reserves them, so the row does not shift when the face changes. */
export const FACE_CELLS = 7

export const FACE_STYLE: Record<Mood, { color?: 'claude' | 'warning' | 'error'; dimColor?: boolean }> = {
  good: { color: 'claude' },
  heavy: { color: 'warning' },
  full: { color: 'error' },
  busy: { dimColor: true },
}

const RANK: Record<ContextLevel, number> = { ok: 0, notice: 1, warn: 2 }

export const moodForLevel = (level: ContextLevel): Exclude<Mood, 'busy'> =>
  level === 'warn' ? 'full' : level === 'notice' ? 'heavy' : 'good'

/** How the mascot feels: the worse of the context's fill and the advice on show; busy while it works for the person. */
export const moodOf = (f: Facts, speaking: { level: 'notice' | 'warn' } | null, isCompacting: boolean): Mood => {
  if (isCompacting) return 'busy'
  const fromContext = contextLevel(scaledPercent(f))
  const fromAdvice: ContextLevel = speaking?.level ?? 'ok'
  return moodForLevel(RANK[fromContext] >= RANK[fromAdvice] ? fromContext : fromAdvice)
}

/** A line the mascot says, for a toast. */
export const say = (mood: Mood, text: string): string => `${FACE[mood]} ${text}`
