import type { Facts } from '../../types'

import { REFERENCE_WINDOW, THRESHOLDS, contextLevel, scaledPercent } from './advice'
import { FRAMES, type Look, PICTURES } from './cat'

/** The conversation, grown this far past what an empty session holds, is where Clawd starts to speed up from its stroll. */
export const WAKE_TOKENS = 20_000
/** What an empty session holds, until the real figure is read from the breakdown. */
export const BASELINE_FALLBACK = 25_000
/** How long the prompt cache lives when nothing says otherwise (an API key's): without a request for this long it is gone, and Clawd sleeps. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000
/** The run-up from the stroll to the sweat is never shorter than this many points of the context scale, however small the window. */
const MIN_RUN_UP = 10

/** Milliseconds between frames: a stroll, and a sprint. */
export const SLOW_PERIOD_MS = 260
export const FAST_PERIOD_MS = 70
const SLEEP_PERIOD_MS = 700
const JUMP_PERIOD_MS = 90
/** Frames a jump plays: twice round its pictures (four times round the cells' four). */
export const JUMP_STEPS = PICTURES.jump * 2

/** What Clawd does at a glance, for the pane's demonstration. */
export type Demo = 'sleep' | 'walk' | 'trot' | 'run' | 'sprint' | 'sweat' | 'jump'

export const DEMO_SPEED: Record<Exclude<Demo, 'sleep' | 'jump'>, number> = { walk: 0.1, trot: 0.35, run: 0.65, sprint: 0.9, sweat: 1 }

/** How long a demonstration lasts. */
export const DEMO_MS = 12_000

/** Where on the scale of `scaledPercent` the stroll ends: an empty session plus `WAKE_TOKENS` more. */
const wakePercentOf = (f: Facts): number => {
  const window = Math.min(f.contextWindow ?? REFERENCE_WINDOW, REFERENCE_WINDOW)
  const percent = (((f.baselineTokens ?? BASELINE_FALLBACK) + WAKE_TOKENS) / window) * 100

  return Math.min(percent, THRESHOLDS.contextWarn - MIN_RUN_UP)
}

/**
 * The speed of the run, by the size of the conversation: 0 up to a little past what an empty session holds, rising to 1 where the
 * context turns red (`contextWarn`, on the scale of `scaledPercent`, the point of the sweat and of the suggestion to compact). So
 * Clawd is at its fastest exactly when it starts to sweat.
 */
export const speedOf = (f: Facts): number => {
  const percent = scaledPercent(f)
  if (percent === null) return 0
  const from = wakePercentOf(f)

  return Math.max(0, Math.min(1, (percent - from) / (THRESHOLDS.contextWarn - from)))
}

/** Milliseconds between frames at a speed: linear from a stroll to a sprint. */
export const periodOf = (speed: number): number =>
  Math.round(SLOW_PERIOD_MS - (SLOW_PERIOD_MS - FAST_PERIOD_MS) * Math.max(0, Math.min(1, speed)))

/** At the top of the speed: the same point as `speedOf` reaching 1. */
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

/**
 * What Clawd has been doing since the band last moved it: the frames shown, the time since the last request kept the prompt cache
 * warm (`null`: none yet, so there is no cache), how long that cache lives, a jump or a demonstration.
 */
export type CatState = { steps: number; idleMs: number | null; ttlMs: number; jumpLeft: number; demo: Demo | null }

export const initialCat: CatState = { steps: 0, idleMs: null, ttlMs: DEFAULT_CACHE_TTL_MS, jumpLeft: 0, demo: null }

export type CatView = {
  look: Look
  /** Milliseconds until the next frame. */
  periodMs: number
  /** What Clawd is up to, in a line. */
  phrase: string
  /** Nothing moves: Clawd sleeps for good until someone is back, so no timer need run. */
  isResting: boolean
}

/** Clawd for these facts and this state: pure, so the band and the timer agree. */
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

  // Asleep for good: the cache is gone, so nothing need run until the person is back.
  if (s.idleMs !== null && s.idleMs >= s.ttlMs) {
    return {
      look: { pose: 'sleep', frame: 0, isSweating: false, step: 1 },
      periodMs: SLEEP_PERIOD_MS,
      phrase: 'キャッシュが切れたので眠っています',
      isResting: true,
    }
  }

  // No request yet in this session: nothing is cached. Asleep, breathing, until the first word.
  if (s.idleMs === null) {
    return {
      look: { pose: 'sleep', frame: s.steps % FRAMES.sleep, isSweating: false, step: s.steps },
      periodMs: SLEEP_PERIOD_MS,
      phrase: 'ぐっすり眠っています。話しかけると起きます',
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
