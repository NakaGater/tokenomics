import type { Facts } from '../../types'

import { contextLevel, scaledPercent } from './advice'
import { FRAMES, type Look, PICTURES } from './cat'

/** The conversation, grown past what an empty session holds, wakes the cat at this size. */
export const WAKE_TOKENS = 20_000
/** The cat is at full speed when the conversation has grown this large (less, in a smaller window). */
export const FULL_TOKENS = 200_000
/** What an empty session holds, until the real figure is read from the breakdown. */
export const BASELINE_FALLBACK = 25_000
/** Without a word from the person for this long the cat curls up, and nothing is redrawn until they are back. */
export const IDLE_SLEEP_MS = 5 * 60_000

/** Milliseconds between frames: a stroll, and a sprint. */
export const SLOW_PERIOD_MS = 260
export const FAST_PERIOD_MS = 70
const SLEEP_PERIOD_MS = 700
const JUMP_PERIOD_MS = 90
/** Frames a jump plays: twice round its pictures (four times round the cells' four). */
export const JUMP_STEPS = PICTURES.jump * 2

/** What the cat does at a glance, for the pane's demonstration. */
export type Demo = 'sleep' | 'walk' | 'trot' | 'run' | 'sprint' | 'sweat' | 'jump'

export const DEMO_SPEED: Record<Exclude<Demo, 'sleep' | 'jump'>, number> = { walk: 0.1, trot: 0.35, run: 0.65, sprint: 1, sweat: 1 }

/** How long a demonstration lasts. */
export const DEMO_MS = 12_000

/** Tokens the conversation has added to what an empty session holds. */
export const growthOf = (f: Facts): number => Math.max(0, (f.contextTokens ?? 0) - (f.baselineTokens ?? BASELINE_FALLBACK))

/** The size at which the cat runs flat out: 200k, or what the window leaves if that is less. */
export const fullTokensOf = (f: Facts): number =>
  Math.max(WAKE_TOKENS * 2, Math.min(FULL_TOKENS, (f.contextWindow ?? FULL_TOKENS) - (f.baselineTokens ?? BASELINE_FALLBACK)))

/** 0 when the conversation has only just grown awake, 1 at a sprint. */
export const speedOf = (f: Facts): number => {
  const full = fullTokensOf(f)
  return Math.max(0, Math.min(1, (growthOf(f) - WAKE_TOKENS) / (full - WAKE_TOKENS)))
}

export const isAsleep = (f: Facts): boolean => growthOf(f) < WAKE_TOKENS

/** Milliseconds between frames at a speed: linear from a stroll to a sprint. */
export const periodOf = (speed: number): number =>
  Math.round(SLOW_PERIOD_MS - (SLOW_PERIOD_MS - FAST_PERIOD_MS) * Math.max(0, Math.min(1, speed)))

export const isSweating = (f: Facts): boolean => contextLevel(scaledPercent(f)) === 'warn'

export type Stage = 'walk' | 'trot' | 'run' | 'sprint'

export const stageOf = (speed: number): Stage => (speed < 0.2 ? 'walk' : speed < 0.5 ? 'trot' : speed < 0.8 ? 'run' : 'sprint')

/** A stroll and a trot walk (the picture's walking cat); a run and a sprint gallop. */
export const isWalkingAt = (speed: number): boolean => stageOf(speed) === 'walk' || stageOf(speed) === 'trot'

const PHRASE: Record<Stage, string> = {
  walk: 'のんびり歩いています',
  trot: '小走りです。会話が育ってきました',
  run: '走っています。区切りで要約か /clear を',
  sprint: '全力で走っています。そろそろ要約を',
}

/** What the cat has been doing since the band last moved it: the frames shown, the idle time, a jump or a demonstration. */
export type CatState = { steps: number; idleMs: number; jumpLeft: number; demo: Demo | null }

export const initialCat: CatState = { steps: 0, idleMs: 0, jumpLeft: 0, demo: null }

export type CatView = {
  look: Look
  /** Milliseconds until the next frame. */
  periodMs: number
  /** What the cat is up to, in a line. */
  phrase: string
  /** Nothing moves: the cat sleeps for good until someone is back, so no timer need run. */
  isResting: boolean
}

/** The cat for these facts and this state: pure, so the band and the timer agree. */
export const catView = (f: Facts, s: CatState): CatView => {
  if (s.jumpLeft > 0 || s.demo === 'jump') {
    const played = s.demo === 'jump' ? s.steps : JUMP_STEPS - s.jumpLeft
    return {
      look: { pose: 'jump', frame: played % FRAMES.jump, isSweating: false, step: played },
      periodMs: JUMP_PERIOD_MS,
      phrase: 'すっきり軽くなりました！',
      isResting: false,
    }
  }

  if (s.demo === 'sleep') {
    return {
      look: { pose: 'sleep', frame: s.steps % FRAMES.sleep, isSweating: false, step: s.steps },
      periodMs: SLEEP_PERIOD_MS,
      phrase: 'ぐっすり眠っています',
      isResting: false,
    }
  }

  if (s.demo !== null) {
    const speed = DEMO_SPEED[s.demo]
    const sweating = s.demo === 'sweat'
    return {
      look: { pose: 'run', frame: s.steps % FRAMES.run, isSweating: sweating, step: s.steps, isWalking: isWalkingAt(speed) },
      periodMs: periodOf(speed),
      phrase: sweating ? '汗だくです。要約をおすすめします' : PHRASE[stageOf(speed)],
      isResting: false,
    }
  }

  if (s.idleMs >= IDLE_SLEEP_MS) {
    return {
      look: { pose: 'sleep', frame: 0, isSweating: false, step: 1 },
      periodMs: SLEEP_PERIOD_MS,
      phrase: 'お休み中です（しばらく操作がありません）',
      isResting: true,
    }
  }

  if (isAsleep(f)) {
    return {
      look: { pose: 'sleep', frame: s.steps % FRAMES.sleep, isSweating: false, step: s.steps },
      periodMs: SLEEP_PERIOD_MS,
      phrase: 'ぐっすり眠っています。会話はまだ軽いです',
      isResting: false,
    }
  }

  const speed = speedOf(f)
  const sweating = isSweating(f)
  return {
    look: { pose: 'run', frame: s.steps % FRAMES.run, isSweating: sweating, step: s.steps, isWalking: isWalkingAt(speed) },
    periodMs: periodOf(speed),
    phrase: sweating ? '汗だくです。要約をおすすめします' : PHRASE[stageOf(speed)],
    isResting: false,
  }
}
