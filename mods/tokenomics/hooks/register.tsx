import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown, SessionMessage, ToolCallResult, TurnStepResult, TurnUsage } from 'claude-code'

import type { EffortSetting, Facts, HeavyItem, ModelRow, OfferKind, OpenOffer, RequestSize, Savings } from '../types'

import { THRESHOLDS, computeAdvice, nextAdvice } from './lib/advice'
import { catCells, catPng } from './lib/cat'
import {
  applyAgentTurn,
  applyBaseline,
  applyBigOutput,
  applyBoundary,
  applyCleared,
  applyCompacted,
  applyConversation,
  applyMeasure,
  applyPrompt,
  applyRequest,
  applyResume,
  applySentIn,
  applyStep,
  applyTurn,
  initialFacts,
  pruneDismissed,
} from './lib/facts'
import { estimateTokens, formatTokens, formatUsd, turnTokens } from './lib/format'
import { buildHandoff, clearPointer, compactPointer, formatGit, handoffDir, handoffPath, hasWork, withGit, withPointer } from './lib/handoff'
import { heavyFrom } from './lib/heavy'
import { say } from './lib/mascot'
import { EFFORT_LABEL, MODEL_LABEL, type SavingKey, activeSavings, cappedEffort, fitsWindow, initialModes, tagOf } from './lib/modes'
import {
  OFFER_NAMES,
  type Offer,
  WINDOW_TOKENS,
  computeOffers,
  isEpisodeId,
  needsConversationSize,
  nextOffer,
  pruneSeen,
  standingOffers,
} from './lib/offers'
import { DEMO_MS, type CatState, type Demo, JUMP_STEPS, catView } from './lib/pace'
import { DIGEST, digestOutput, digestPath, isDigestFile, isInsideDir, isNoteFile, normalizeCommand } from './lib/core/digest'
import { decideSpawn, typeTag } from './lib/core/downgrade'
import { ASSUMED_TURNS_AFTER, coldTurnUsd, heavyLevel, keptOutUsd, milliUsd, modelFamily, usageInputUsd, warmTurnUsd } from './lib/core/economics'
import { forkEnded, forkOutcome, forkRead, forkSet, forkType, forkedId } from './lib/core/forks'
import { shortHash } from './lib/core/hash'
import { type Kind, type RawEvent, appendRaw, emptyLedger, digestThreshold, exportLedger, parseLedger, retiredNudges, savingsToday, sessionKey } from './lib/core/ledger'
import { ANSWER_TURNS, clearStakeUsd, coldReturn, risen, topicShift } from './lib/core/moments'
import { type Candidate, DEMO_LINE, DEMO_SHORT, chooseNudge, nudgeLine, nudgeShort } from './lib/core/nudges'
import { type Mode, cacheTtlMs, parseOptions } from './lib/core/options'
import { type MeasureId, armOf, failed, isTripped, modeOf, succeeded } from './lib/core/policy'
import { freshState, resetConversation, resetSession, touch } from './lib/core/state'
import { callKind, lightUse, steerAnswered, steerNote, steerSeen, steerStep, steerTurn } from './lib/core/steer'
import { advisorMs, advisorRead, noteOpenedBy, noteWritten, subagentSpend } from './lib/core/spend'
import { cacheShare, contextBucket, idleBucket, wasCold } from './lib/core/usage'
import { isBoundaryCommand } from './lib/signals'
import { report, settingsReport } from './lib/status'
import { commandArg, commandOf, startsAt, windowView } from './lib/window'
import { WORKER, WORKER_DESCRIPTION, WORKER_PROMPT, WORKER_TOOLS } from './lib/worker'
import { Band } from './ui/band'
import { OfferView } from './ui/offer'
import { Pane, SettingsPane } from './ui/pane'
import type { ImageElement, RasterElement } from './ui/ui'

type Dollar = EngineInterface

const NAME = 'tokenomics'
const PANE = 'tokenomics'
const SETTINGS_PANE = 'tokenomics-settings'
const OFFER_PANE = 'tokenomics-offer'

/**
 * Whether the dialog asks for the keyboard when it opens. It would be right after a reply, which is when
 * people start typing, so by default it does not: the dialog is there to click, and Escape at an empty
 * prompt still closes it. Turn this on only if keys typed meanwhile are seen to reach the prompt.
 */
const DIALOG_TAKES_KEYS = false

const KINDS = Object.keys(OFFER_NAMES) as OfferKind[]

/**
 * Whether the cat, the band, the pane and the dialog are drawn (the `hud` setting). Off, the mod draws nothing and puts no
 * suggestion to the person, and the savings layer (hooks/core.ts) goes on as before. A change of setting loads the module again.
 */
let isHud = true

/**
 * True while the mod itself changes the model, to put it back or because the person accepted a move: the
 * switch warning would only ask again what the person has just been told and agreed to.
 */
let isOwnSwitch = false
/** A model turn is running: a suggestion waits for it to end. */
let isTurnRunning = false
/** Tool calls the running turn has made; counted here, since the band need not redraw for each. */
let toolsThisTurn = 0
/** What each model request of the main loop's running turn used, in order. */
let requestsThisTurn: RequestSize[] = []
/** The turn running (or last run) was set going by something sent in, not by the person. */
let isSentInTurn = false

// The cat on the band moves faster than anything is redrawn, so it lives here and is repainted with `$.ui.blit`:
// one call a frame, no render pass. What it needs of the session is mirrored from the facts as they change.
/** The band's own id once it has drawn the cat; null while nothing is showing it, which also stops the timer. */
let catSite: string | null = null
let catTimer: { cancel: () => void } | null = null
/** Milliseconds the pending timer was set for. */
let catDueMs = 0
/** The latest facts, for the timer to read without asking the engine for them every frame. */
let catFacts: Facts = initialFacts
/** Frames shown since the cat last changed what it was doing. */
let catSteps = 0
/** Milliseconds the person has been quiet; at five minutes the cat curls up and the timer stops. */
let catIdleMs = 0
/** Frames of a jump still to play. */
let catJumpLeft = 0
let catDemo: Demo | null = null
let catDemoLeftMs = 0
/** The line the band last drew under the figures: it is text, so it changes only when the band is drawn again. */
let catPhrase = ''
/** The cells last painted, so a redraw of the band carries on from the frame on show instead of the first. */
let catShown = ''

/**
 * Whether the cat is drawn as a picture. The terminal's own words decide whether to try (`imageHint`); the first repaint
 * answers: a blit to a picture the terminal cannot draw is refused. After that the cat is drawn in cells.
 */
let catImages: 'maybe' | 'yes' | 'no' = 'maybe'
/** What the terminal's own words say of pictures; null until read, at the first draw of the band or the start of a session (a reload has no start). */
let imageHint: boolean | null = null
/** The picture last painted, so a redraw of the band carries on from the frame on show. */
let catShownPng = ''
/** The band's last draw gave the cat as a picture. */
let catAsImage = false
let imageProbe: { cancel: () => void } | null = null

const catState = (): CatState => ({ steps: catSteps, idleMs: catIdleMs, jumpLeft: catJumpLeft, demo: catDemo })

/** What the mod changed in the saved model setting, kept past the session so it can be undone. */
type Pending = { previous: string; switchedTo: string }

const pendingOf = (raw: unknown): Pending | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const fields = raw as Record<string, unknown>
  return typeof fields.previous === 'string' && typeof fields.switchedTo === 'string'
    ? { previous: fields.previous, switchedTo: fields.switchedTo }
    : null
}

// The scan that checks `$.state` reads these as written: plugin and key are literals.
const facts = atom({ plugin: 'tokenomics', key: 'facts' } as const, initialFacts)
const dismissed = atom({ plugin: 'tokenomics', key: 'dismissed' } as const, [] as string[])
const heavy = atom({ plugin: 'tokenomics', key: 'heavy' } as const, null as HeavyItem[] | null)
const busy = atom({ plugin: 'tokenomics', key: 'busy' } as const, null as 'compact' | null)
const modes = atom({ plugin: 'tokenomics', key: 'modes' } as const, initialModes)
const modelRow = atom({ plugin: 'tokenomics', key: 'modelRow' } as const, null as ModelRow | null)
const openOffer = atom({ plugin: 'tokenomics', key: 'offer' } as const, null as OpenOffer | null)
const seen = atom({ plugin: 'tokenomics', key: 'seen' } as const, [] as string[])
const muted = atom({ plugin: 'tokenomics', key: 'muted' } as const, [] as OfferKind[])
const nudge = atom({ plugin: 'tokenomics', key: 'nudge' } as const, null as string | null)
const windowPick = atom({ plugin: 'tokenomics', key: 'windowPick' } as const, null as number | null)
const isSettingWindow = atom({ plugin: 'tokenomics', key: 'isSettingWindow' } as const, false)

/** Paints the cat's next frame and asks for the one after it, at the pace its speed calls for. */
const stepCat = async ($: Dollar): Promise<void> => {
  catTimer = null
  // Reduced motion: the cat stands where it is. (A picture for each state is still drawn, with the band.)
  if (catSite === null || catFacts.isMotionReduced) return
  const view = catView(catFacts, catState())
  catShown = catCells(view.look)
  catShownPng = catPng(view.look)
  // The words beside the cat follow what it is doing: a change of state, not of frame, draws the band again.
  if (view.phrase !== catPhrase) {
    catPhrase = view.phrase
    $.ui.invalidate('ui.render')
  }
  try {
    const painted = catAsImage
      ? await $.ui.blit({ requestId: catSite, key: 'cat', source: { png: catShownPng } })
      : await $.ui.blit({ requestId: catSite, key: 'cat', cells: catShown })
    // Not on screen (collapsed, a survey, a narrow terminal): stop; the next draw of the band starts it again.
    if (painted.deny !== undefined) {
      // A picture refused before one was ever taken: this terminal draws none. The band draws cells from now on.
      if (catAsImage && catImages === 'maybe') giveUpImages($)
      catSite = null
      return
    }
    if (catAsImage) catImages = 'yes'
  } catch {
    catSite = null
    return
  }
  catSteps += 1
  if (catJumpLeft > 0) {
    catJumpLeft -= 1
  } else if (catDemo !== null) {
    catDemoLeftMs -= view.periodMs
    if (catDemoLeftMs <= 0) {
      catDemo = null
      catSteps = 0
    }
  } else {
    catIdleMs += view.periodMs
  }
  // A cat curled up for the night needs no timer: the person's next word wakes it.
  if (view.isResting && catJumpLeft === 0 && catDemo === null) return
  catDueMs = view.periodMs
  catTimer = $.clock.after(view.periodMs, () => void stepCat($))
}

const startCat = ($: Dollar, afterMs: number): void => {
  if (catTimer !== null || catSite === null || catFacts.isMotionReduced) return
  catDueMs = afterMs
  catTimer = $.clock.after(afterMs, () => void stepCat($))
}

/** The terminal draws no pictures: the cat goes back to cells, and the band is drawn again to say so. */
const giveUpImages = ($: Dollar): void => {
  catImages = 'no'
  catAsImage = false
  $.ui.invalidate('ui.render')
}

/** Asks the terminal once, with the picture on screen, whether it draws it; a cat curled up has no timer to ask for it. */
const probeImage = async ($: Dollar): Promise<void> => {
  imageProbe = null
  if (catSite === null || !catAsImage || catImages !== 'maybe') return
  // Nothing may have been painted yet (reduced motion draws only the band): ask with the picture the band shows.
  const png = catShownPng !== '' ? catShownPng : catPng(catView(catFacts, catState()).look)
  try {
    const painted = await $.ui.blit({ requestId: catSite, key: 'cat', source: { png } })
    if (painted.deny !== undefined) giveUpImages($)
    else catImages = 'yes'
  } catch {
    // Not answered: the next draw asks again.
  }
}

/** What the terminal says of itself: kitty and Ghostty draw pictures, tmux passes none; `TOKENOMICS_CAT_IMAGE` 1 or 0 decides it. */
const imagesLikely = async ($: Dollar): Promise<boolean> => {
  const forced = await $.env.get('TOKENOMICS_CAT_IMAGE')
  if (forced === '1') return true
  if (forced === '0') return false
  if ((await $.env.get('TMUX')) !== undefined) return false
  if ((await $.env.get('ORCA_IMAGE_PROTOCOL')) === 'kitty') return true
  if ((await $.env.get('KITTY_WINDOW_ID')) !== undefined) return true
  if ((await $.env.get('GHOSTTY_RESOURCES_DIR')) !== undefined) return true
  const program = (await $.env.get('TERM_PROGRAM'))?.toLowerCase()
  return program === 'ghostty' || program === 'kitty'
}

/** A cat that has just been asked to go faster should not wait out a slow frame: the pending one is brought forward. */
const hurryCat = ($: Dollar, f: Facts): void => {
  if (catTimer === null || catView(f, catState()).periodMs >= catDueMs) return
  catTimer.cancel()
  catTimer = null
  startCat($, 1)
}

/** The person did something: the cat is awake. */
const nudgeCat = ($: Dollar): void => {
  catIdleMs = 0
  startCat($, 1)
}

/** Lighter at last: the cat jumps for joy. */
const jumpCat = ($: Dollar): void => {
  if (catFacts.isMotionReduced) return
  catJumpLeft = JUMP_STEPS
  nudgeCat($)
  hurryCat($, catFacts)
}

const peekCat = ($: Dollar, demo: Demo): void => {
  if (catFacts.isMotionReduced) return
  catSteps = 0
  if (demo === 'jump') {
    catDemo = null
    catJumpLeft = JUMP_STEPS
  } else {
    catDemo = demo
    catDemoLeftMs = DEMO_MS
  }
  nudgeCat($)
  hurryCat($, catFacts)
}

const stopCat = (): void => {
  catTimer?.cancel()
  catTimer = null
  imageProbe?.cancel()
  imageProbe = null
  catSite = null
}

/** A session begins (or the module was loaded again): the cat starts over, curled up. */
const resetCat = (): void => {
  stopCat()
  catFacts = initialFacts
  catSteps = 0
  catIdleMs = 0
  catJumpLeft = 0
  catDemo = null
  catDemoLeftMs = 0
  catShown = ''
  catShownPng = ''
  catPhrase = ''
}

/** Notes before a compaction are on without being asked (`handoffNote`), except for a person held back from the savings. */
const isNoteByDefault = (): boolean => sv.options.handoffNote && sv.arm !== 'control'

const offerContext = async ($: Dollar) => {
  // Not `svEnsure`: this runs while drawing, where a refused first read would leave the init failed for the whole load.
  // Before it has run the person counts as one who is not held back, which at worst words an offer for a moment.
  const m = await read($, modes)

  // What the offers say of the note is true of the note that is written, whether it was asked for or is on by default.
  return { facts: await read($, facts), modes: { ...m, isHandoffOn: m.isHandoffOn || isNoteByDefault() }, modelRow: await read($, modelRow) }
}

/** The offer with this id, if the situation still calls for it. */
const offerFor = async ($: Dollar, id: string): Promise<Offer | undefined> =>
  computeOffers(await offerContext($)).find(o => o.id === id)

/** Takes down the suggestion on screen, dialog or card, and says which it was. */
const closeOffer = async ($: Dollar): Promise<OpenOffer | null> => {
  const open = await read($, openOffer)
  if (open === null) return null
  await update($, openOffer, () => null)
  if (open.view === 'dialog') {
    try {
      await $.ui.close({ id: OFFER_PANE })
    } catch {
      // Already gone.
    }
  }
  return open
}

/** The one-line suggestion in the cat's card is for the moment after a reply; it goes when that moment has passed. */
const clearNudge = async ($: Dollar): Promise<void> => {
  if ((await read($, nudge)) === null) return
  await update($, nudge, () => null)
  $.ui.invalidate('ui.render')
}

/**
 * Writes the facts, then forgets the dismissals and the suggestions whose situation has ended; and
 * takes down a suggestion on screen that no longer fits, so it is never accepted for a case that has passed.
 */
const change = async ($: Dollar, fn: (f: Facts) => Facts): Promise<void> => {
  const next = await update($, facts, fn)
  catFacts = next
  hurryCat($, next)
  await update($, dismissed, d => pruneDismissed(d, next))
  await update($, seen, s => pruneSeen(s, next))
  const open = await read($, openOffer)
  if (open !== null && (await offerFor($, open.id)) === undefined) await closeOffer($)
}

/** The conversation itself: what the breakdown lists as messages, apart from the prompt, tools and the rest. */
const messagesOf = (b: SessionContextBreakdown): number =>
  b.categories.filter(c => c.kind === 'used' && /message/i.test(c.name)).reduce((sum, c) => sum + c.tokens, 0)

/** When the breakdown, which holds the size the engine auto-compacts at, was last read; and how long it is trusted between turns. */
let breakdownAt = 0
const BREAKDOWN_EVERY_MS = 60_000

/** Reads the engine's own figures; with `withBreakdown`, also what fills the context (a local estimate, free). */
const refreshUsage = async ($: Dollar, withBreakdown: boolean): Promise<void> => {
  try {
    const usage = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
    const breakdown = usage.context.breakdown
    await change($, f => {
      const measured = applyMeasure(f, usage)
      if (breakdown === undefined) return measured
      const messages = messagesOf(breakdown)
      const known = {
        ...applyConversation(measured, messages),
        isAutoCompactEnabled: breakdown.isAutoCompactEnabled,
        // Absent while auto-compaction is off.
        autoCompactThreshold: breakdown.autoCompactThreshold ?? null,
        autoCompactSource: breakdown.autocompactSource,
        autoCompactWindow: breakdown.rawMaxTokens,
      }
      // What an empty session holds is what a response measured less the conversation: learned from the first one.
      return usage.context.tokens === undefined ? known : applyBaseline(known, usage.context.tokens, messages)
    })
    if (breakdown !== undefined) {
      breakdownAt = await $.clock.now()
      await update($, heavy, () => heavyFrom(breakdown))
    }
  } catch {
    // The figures are a convenience: the band keeps what it has.
  }
}

/** The pane's list of what is heavy is being made again, or is waiting to be: a second is not started over it. */
let isHeavyPending = false

/** The analysis pane is up where it can be seen (the list of what is heavy is in it, and nowhere else). */
const isAnalysisUp = async ($: Dollar): Promise<boolean> => {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  } catch {
    return false
  }
}

/**
 * While the analysis pane is up, its list of what is heavy is made again after every reply, not only once a minute. Nothing here is
 * waited for: the breakdown is a local estimate that sends nothing, but the end of a reply does not hang on how long it takes. It runs
 * once the hook has returned, which also lets it see the reply that has just ended. One at a time, and none for a pane that is shut.
 */
const refreshHeavyLater = ($: Dollar): void => {
  if (isHeavyPending) return
  isHeavyPending = true
  try {
    $.clock.after(1, () => {
      void (async () => {
        try {
          if (await isAnalysisUp($)) await refreshUsage($, true)
        } finally {
          isHeavyPending = false
        }
      })()
    })
  } catch {
    isHeavyPending = false
  }
}

/** Reads the /config rows the suggestions act on: autocompact, prompt suggestions, and which model is in use. */
const refreshSettings = async ($: Dollar): Promise<void> => {
  try {
    const rows = await $.config.list()
    const auto = rows.find(r => r.key === 'autoCompact')
    const suggest = rows.find(r => r.key === 'promptSuggestionEnabled')
    const model = rows.find(r => r.key === 'model')
    const reduce = rows.find(r => r.key === 'reduceMotion')
    await change($, f => ({
      ...f,
      isMotionReduced: typeof reduce?.value === 'boolean' ? reduce.value : f.isMotionReduced,
      isAutoCompactEnabled: typeof auto?.value === 'boolean' ? auto.value : f.isAutoCompactEnabled,
      canSetAutoCompact: auto !== undefined && auto.kind === 'boolean' && !auto.isLocked,
      isSuggestEnabled:
        suggest !== undefined && suggest.kind === 'boolean' && !suggest.isLocked && typeof suggest.value === 'boolean'
          ? suggest.value
          : null,
    }))
    await update($, modelRow, () =>
      model !== undefined && typeof model.value === 'string' ? { value: model.value, options: [...(model.options ?? [])] } : null,
    )
  } catch {
    // The suggestions that need them then do not arise.
  }
}

/**
 * The analysis pane or the settings pane, one at a time: the other is closed first, so that what the person pressed is what
 * they see (two panes open would be two tabs, and the new one might not be the one shown).
 */
const showPane = async ($: Dollar, id: typeof PANE | typeof SETTINGS_PANE) => {
  await $.ui.close({ id: id === PANE ? SETTINGS_PANE : PANE })
  const opened = await $.ui.open({ id, title: id === PANE ? '分析' : '設定' })
  await refreshUsage($, true)
  await refreshSettings($)
  return opened
}

const openPane = ($: Dollar) => showPane($, PANE)
const openSettings = ($: Dollar) => showPane($, SETTINGS_PANE)

/**
 * `git status --short --branch` of the working directory, as lines; none where it is not a repository, git cannot be run,
 * or there is not the time (`leftMs`: what a hook with a limit has left, less a margin for the rest of its work).
 */
const gitState = async ($: Dollar, leftMs = Infinity): Promise<string[]> => {
  const timeoutMs = Math.min(2_000, leftMs)
  if (!(timeoutMs >= 300)) return []
  try {
    const ran = await $.process.run(['git', 'status', '--short', '--branch'], { timeoutMs })
    return ran.exitCode === 0 ? formatGit(ran.stdout) : []
  } catch {
    return []
  }
}

/** The file name of a path: all the ledger and the notes' memory keep of where a note is. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The note the latest compaction was preceded by, until the conversation that goes on has been told where it is. */
let compactedNote: string | null = null

/** The note a compaction is preceded by: written to a file by rule, its place carried into the summary. */
const prepareHandoff = async (
  $: Dollar,
  trigger: string,
  instructions: string | undefined,
  messages?: readonly SessionMessage[],
  leftMs = Infinity,
): Promise<string | undefined> => {
  const m = await read($, modes)
  const isPre = trigger === 'precompute'
  if (!isPre) compactedNote = null
  await svEnsure($)
  if (!m.isHandoffOn && !isNoteByDefault()) return instructions
  // The note holds the person's requests, files and commands: it is kept only in a temp folder that is theirs alone.
  if (!sv.canSave) return instructions
  try {
    const path = handoffPath(handoffDir(await $.env.get('TMPDIR'), await $.session.id()), isPre ? 'pre' : m.handoffs + 1)
    const stamp = new Date(await $.clock.now()).toISOString()
    // Git gets only the time the hook can spare: a slow repo must not make the compaction's own hook overrun.
    const text = withGit(buildHandoff(messages ?? (await $.session.messages()), stamp), await gitState($, leftMs - 300))
    await $.fs.write(path, text)
    if (!isPre) {
      compactedNote = path
      sv.notes = noteWritten(sv.notes, baseName(path), { kind: 'compaction', turn: sv.turnIndex, isOpened: false })
      await update($, modes, x => ({ ...x, handoffs: x.handoffs + 1 }))
      await svRecord($, 'S', 'observe', 'signal', 'compact_note_written', { chars: text.length }, true)
    }
    return withPointer(instructions, path)
  } catch {
    // A note is a convenience: the compaction goes on without it.
    return instructions
  }
}

/** The note a `/clear` just left, until the conversation that follows has been told where it is. */
let clearedNote: { path: string; text: string } | null = null

/**
 * `/clear`: what the conversation was doing is written down by rule, in the time `session.end` leaves.
 * Only the transcript is read and one file written here; the git state is added when the next conversation starts.
 * Each way it can come to nothing is a quiet signal in the ledger, so a use shows whether it works.
 */
const svClearNote = async ($: Dollar, remainingMs: number): Promise<void> => {
  clearedNote = null
  compactedNote = null
  if (!sv.options.handoffNote) return
  try {
    await svEnsure($)
    const skip = async (why: string): Promise<void> => svRecord($, 'S', 'observe', 'signal', `clear_note_${why}`, undefined, true)
    if (sv.arm === 'control') return skip('skipped_control')
    if (!sv.canSave) return skip('skipped_tmp')
    if (remainingMs < 700) return skip('skipped_budget')
    const messages = await $.session.messages()
    if (messages.length === 0) return skip('skipped_unavailable')
    if (!hasWork(messages)) return skip('skipped_empty')
    const now = await $.clock.now()
    const path = handoffPath(sv.saveDir, now)
    const text = buildHandoff(messages, new Date(now).toISOString(), 'clear')
    await $.fs.write(path, text)
    clearedNote = { path, text }
    sv.notes = noteWritten(sv.notes, baseName(path), { kind: 'clear', turn: sv.turnIndex, isOpened: false })
    await svRecord($, 'S', 'observe', 'signal', 'clear_note_written', { chars: text.length }, true)
  } catch {
    await svRecord($, 'S', 'observe', 'signal', 'clear_note_failed', undefined, true)
  }
}

/** The conversation after a `/clear`, told in one line where the note of the one before is. Its git state is put into the note now. */
const svClearPointer = async ($: Dollar, leftMs: number): Promise<string | undefined> => {
  if (!sv.options.handoffNote) return undefined
  const note = clearedNote
  clearedNote = null
  if (note === null) {
    await svRecord($, 'S', 'observe', 'signal', 'clear_start_without_note', undefined, true)
    return undefined
  }
  try {
    // The line is the valuable part: git gets only the time the hook can spare, and never costs it.
    const git = await gitState($, leftMs - 300)
    if (git.length > 0) await $.fs.write(note.path, withGit(note.text, git))
  } catch {
    // The note stands without it.
  }
  await svRecord($, 'S', 'observe', 'signal', 'clear_pointer_given', undefined, true)
  return clearPointer(note.path)
}

/** The conversation that goes on after a compaction, told in one line where the note made before it is. */
const svCompactPointer = async ($: Dollar): Promise<string | undefined> => {
  const path = compactedNote
  compactedNote = null
  if (path === null) {
    // A note was to be expected here, and there is none (the compaction was not one this mod saw, or the note could not be made).
    if (isNoteByDefault()) await svRecord($, 'S', 'observe', 'signal', 'compact_start_without_note', undefined, true)
    return undefined
  }
  await svRecord($, 'S', 'observe', 'signal', 'compact_pointer_given', undefined, true)
  return compactPointer(path)
}

/** `/tokenomics handoff`: the note of what a fresh start would lose, written now, with the words to carry it into the next conversation. */
const svHandoff = async ($: Dollar): Promise<string> => {
  await svEnsure($)
  if (!sv.canSave) return 'メモを残せませんでした。一時フォルダ（TMPDIR）が、自分だけが読める場所として設定されていません。'
  try {
    const now = await $.clock.now()
    const path = handoffPath(sv.saveDir, now)
    const text = withGit(buildHandoff(await $.session.messages(), new Date(now).toISOString(), 'fresh'), await gitState($))
    await $.fs.write(path, text)
    sv.notes = noteWritten(sv.notes, baseName(path), { kind: 'fresh', turn: sv.turnIndex, isOpened: false })
    await svRecord($, 'S', 'observe', 'signal', 'fresh_note_written', { chars: text.length }, true)
    return [`要点のメモを残しました: ${path}`, `/clear のあと、続きの会話の最初に「${path} を読んで、続きから進めて」と伝えてください。`].join('\n')
  } catch {
    return 'メモを残せませんでした。'
  }
}

const compact = async ($: Dollar): Promise<void> => {
  if ((await read($, busy)) !== null) return
  await update($, busy, () => 'compact')
  try {
    // A plugin's own call passes through none of its own hooks, so the note is made here.
    const instructions = await prepareHandoff($, 'plugin', undefined)
    const done = await $.session.compact(instructions === undefined ? undefined : { instructions })
    if (done.skip !== undefined) {
      $.ui.toast(say('heavy', 'いまは要約できませんでした。'))
    } else {
      await change($, f => applyCompacted(f, done.tokensAfter))
      await clearNudge($)
      const sizes =
        done.tokensBefore !== undefined && done.tokensAfter !== undefined
          ? `（${formatTokens(done.tokensBefore)} → ${formatTokens(done.tokensAfter)} tok）`
          : ''
      $.ui.toast(say('good', `要約して軽くしました${sizes}`))
      jumpCat($)
      // The person pressed the button: the same answer as typing /compact.
      await svAttempt($, 'C2', () => svAnswered($), undefined)
    }
  } catch {
    $.ui.toast(say('heavy', 'いまは要約できません。返信が終わってから、もう一度お試しください。'))
  } finally {
    await update($, busy, () => null)
  }
}

/**
 * A command the engine has no call for, or one that cannot be undone: the mod only types it for the person, whose
 * Enter is the confirmation. A draft already in the prompt is never overwritten; the person is told what to type.
 */
const typeCommand = async ($: Dollar, command: string, notes: { draft: string; filled: string; failed: string }): Promise<void> => {
  const draft = await $.prompt.read()
  if (draft.text.trim() !== '') {
    $.ui.toast(say('heavy', notes.draft))
    return
  }
  const filled = await $.prompt.fill({ text: command, mode: 'replace' })
  $.ui.toast(say('heavy', filled.isFilled ? notes.filled : notes.failed))
}

/** A conversation cannot be got back, so this only types `/clear` for the person; their Enter is the confirmation. */
const startFresh = ($: Dollar): Promise<void> =>
  typeCommand($, '/clear', {
    draft: '入力欄に /clear と入力して Enter を押すと、新しく始められます（今の会話は消えます）',
    filled: 'Enter で /clear を実行します（今の会話は消えます）',
    failed: '入力欄に /clear と入力すると、新しく始められます（今の会話は消えます）',
  })

/** Where an auto-compact size was chosen: the pane's slider (and its reset), or the one-click offer. */
type WindowSource = 'pane' | 'offer'

/**
 * Sets the auto-compact size (`/autocompact`, saved per model; "auto" is the model's own). There is no setting call for it, so the
 * command is run as the person would run it, and the answer is the size the engine reports afterwards: where the run is refused or
 * changes nothing, the command is typed for the person to confirm instead. A press on a button is the confirmation of the run;
 * it is undone by `/autocompact auto`, which the pane's "標準に戻す" does.
 *
 * The ledger keeps which size was set from where (`window_pane_300k`, `window_offer_300k`, `window_pane_auto`), or that the command
 * was typed instead (`window_typed_pane`): a count, never anything the person wrote.
 */
const setWindow = async ($: Dollar, tokens: number, source: WindowSource): Promise<void> => {
  if (await read($, isSettingWindow)) return
  const view = windowView(await read($, facts))
  if (view === null) return
  const arg = commandArg(view, tokens)
  const command = commandOf(view, tokens)
  const want = arg === 'auto' ? view.standard : tokens
  await update($, isSettingWindow, () => true)
  try {
    let isRun = false
    try {
      await $.command.run({ command: 'autocompact', args: arg })
      isRun = true
    } catch {
      // A build that keeps the command to the person: it is typed below.
    }
    if (isRun) {
      await refreshUsage($, true)
      const now = windowView(await read($, facts))
      if (now !== null && now.current === want) {
        // The thumb stays on the size just set; it starts on the recommended one only when the pane opens.
        await update($, windowPick, () => tokens)
        await svRecord($, 'S', 'observe', 'signal', `window_${source}_${arg}`, undefined, true)
        $.ui.toast(
          say(
            'good',
            arg === 'auto'
              ? `自動要約のタイミングを標準に戻しました（約${formatTokens(startsAt(now, now.current))} tok まで育ってから要約されます）`
              : `自動要約のタイミングを ${formatTokens(tokens)} にしました（約${formatTokens(startsAt(now, now.current))} tok で要約が始まります。モデルごとに保存されます）`,
          ),
        )
        return
      }
    }
    await svRecord($, 'S', 'observe', 'signal', `window_typed_${source}`, undefined, true)
    await typeCommand($, command, {
      draft: `入力欄に ${command} と入力して Enter を押すと、自動要約のタイミングが変わります（モデルごとに保存されます）`,
      filled: `Enter で ${command} を実行します（モデルごとに保存されます。戻すには /autocompact auto）`,
      failed: `入力欄に ${command} と入力すると、自動要約のタイミングが変わります`,
    })
  } finally {
    await update($, isSettingWindow, () => false)
  }
}

/** Back to the model's own size: `/autocompact auto`. */
const resetWindow = async ($: Dollar): Promise<void> => {
  const view = windowView(await read($, facts))
  if (view !== null) await setWindow($, view.standard, 'pane')
}

/** Registers the light helper; there is no unregistering, so `agent.offer` decides whether the model hears of it. */
const registerWorker = async ($: Dollar): Promise<boolean> => {
  try {
    await $.agent.register({
      name: WORKER,
      description: WORKER_DESCRIPTION,
      prompt: WORKER_PROMPT,
      tools: WORKER_TOOLS,
      model: 'haiku',
      effort: 'low',
      // Not the parent's: in an auto or bypass session the helper would otherwise run any command unasked.
      permissionMode: 'default',
      omitClaudeMd: true,
    })
    return true
  } catch {
    return false
  }
}

const turnOnWorker = async ($: Dollar): Promise<void> => {
  if (!(await registerWorker($))) {
    $.ui.toast(say('heavy', '軽量エージェントを用意できませんでした。'))
    return
  }
  await update($, modes, m => ({ ...m, isWorkerOn: true }))
  $.ui.toast(say('good', '軽量エージェントを使えるようにしました。調べものを軽いモデルに任せます。'))
}

const setEffort = async ($: Dollar, cap: EffortSetting | null): Promise<void> => {
  await update($, modes, m => ({ ...m, effort: cap }))
  $.ui.toast(
    say('good', cap === null ? '考える深さを元に戻しました。' : `考える深さを「${EFFORT_LABEL[cap]}」にしました。難しい作業のときは、ペインで戻せます。`),
  )
}

/** The model goes through `/config`, as `/model` does: its own checks apply. */
const setModel = async ($: Dollar, value: string, isQuiet: boolean): Promise<boolean> => {
  try {
    const set = await $.config.set({ key: 'model', value })
    if (set.deny === undefined) return true
    if (!isQuiet) $.ui.toast(say('heavy', `モデルを切り替えられませんでした（${set.deny}）`))
  } catch {
    if (!isQuiet) $.ui.toast(say('heavy', 'モデルを切り替えられませんでした。'))
  }
  return false
}

const switchModel = async ($: Dollar, target: string): Promise<void> => {
  const row = await read($, modelRow)
  if (row === null) return
  const f = await read($, facts)
  if (!fitsWindow(target, f.contextTokens, f.contextWindow)) {
    $.ui.toast(say('heavy', 'いまの会話が大きすぎて、そのモデルでは読み込めません。先に要約してください。'))
    return
  }
  isOwnSwitch = true
  try {
    if (!(await setModel($, target, false))) return
  } finally {
    isOwnSwitch = false
  }
  // `/model` saves the choice for new sessions too, so what to undo is kept past this one.
  const pending = pendingOf(await $.store.get('pendingModel'))
  await $.store.set('pendingModel', { previous: pending?.previous ?? row.value, switchedTo: target })
  await update($, modes, m => ({ ...m, previousModel: m.previousModel ?? row.value }))
  await refreshSettings($)
  $.ui.toast(say('good', `モデルを ${MODEL_LABEL[target] ?? target} にしました。終了するとき ${pending?.previous ?? row.value} に戻します。`))
}

const restoreModel = async ($: Dollar): Promise<void> => {
  const previous = (await read($, modes)).previousModel
  if (previous === null) return
  isOwnSwitch = true
  try {
    if (!(await setModel($, previous, false))) return
  } finally {
    isOwnSwitch = false
  }
  await $.store.delete('pendingModel')
  await update($, modes, m => ({ ...m, previousModel: null }))
  await refreshSettings($)
  $.ui.toast(say('good', `モデルを ${previous} に戻しました。`))
}

/**
 * Puts the saved model back if this mod moved it and nothing else has since: at the end of a session,
 * and again at the next start in case the end was cut short. Returns the model it restored, if any.
 */
const restorePending = async ($: Dollar): Promise<string | null> => {
  try {
    const pending = pendingOf(await $.store.get('pendingModel'))
    if (pending === null) return null
    const row = (await $.config.list()).find(r => r.key === 'model')
    let restored: string | null = null
    // Only while it is still what this mod set: the person may have chosen another model since.
    if (row?.value === pending.switchedTo) {
      isOwnSwitch = true
      try {
        restored = (await setModel($, pending.previous, true)) ? pending.previous : null
      } finally {
        isOwnSwitch = false
      }
    }
    await $.store.delete('pendingModel')
    return restored
  } catch {
    return null
  }
}

const enableAutoCompact = async ($: Dollar): Promise<void> => {
  try {
    const set = await $.config.set({ key: 'autoCompact', value: true })
    if (set.deny !== undefined) {
      $.ui.toast(say('heavy', `自動要約をオンにできませんでした（${set.deny}）`))
      return
    }
    await change($, f => ({ ...f, isAutoCompactEnabled: true }))
    $.ui.toast(say('good', '自動要約をオンにしました（設定に保存されます）'))
  } catch {
    $.ui.toast(say('heavy', '自動要約をオンにできませんでした。'))
  }
}

const turnOffSuggestions = async ($: Dollar): Promise<void> => {
  try {
    const set = await $.config.set({ key: 'promptSuggestionEnabled', value: false })
    if (set.deny !== undefined) {
      $.ui.toast(say('heavy', `プロンプト提案をオフにできませんでした（${set.deny}）`))
      return
    }
    await change($, f => ({ ...f, isSuggestEnabled: false }))
    $.ui.toast(say('good', 'プロンプト提案をオフにしました（設定に保存されます）'))
  } catch {
    $.ui.toast(say('heavy', 'プロンプト提案をオフにできませんでした。'))
  }
}

/** What accepting an offer does. */
const carryOut = async ($: Dollar, offer: Offer): Promise<void> => {
  switch (offer.kind) {
    case 'compact':
      // The note is part of what was offered, for this compaction and the ones after it.
      await update($, modes, m => ({ ...m, isHandoffOn: true }))
      await compact($)
      return
    case 'autocompact':
      await update($, modes, m => ({ ...m, isHandoffOn: true }))
      await enableAutoCompact($)
      return
    case 'window':
      await setWindow($, WINDOW_TOKENS, 'offer')
      return
    case 'boundary':
      await startFresh($)
      return
    case 'worker':
      await turnOnWorker($)
      return
    case 'model':
      if (offer.target !== undefined) await switchModel($, offer.target)
      return
    case 'effort':
      await setEffort($, 'medium')
      return
    case 'suggest':
      await turnOffSuggestions($)
      return
  }
}

/** Ends something that was accepted. */
const stopSaving = async ($: Dollar, key: SavingKey): Promise<void> => {
  if (key === 'effort') return setEffort($, null)
  if (key === 'model') return restoreModel($)
  if (key === 'worker') await update($, modes, m => ({ ...m, isWorkerOn: false }))
  if (key === 'handoff') await update($, modes, m => ({ ...m, isHandoffOn: false }))
  $.ui.toast(say('good', 'やめました。'))
}

/** The kinds the person has asked not to see again, kept past the session. */
const loadMuted = async ($: Dollar): Promise<void> => {
  try {
    const raw = await $.store.get('mutedOffers')
    const list = Array.isArray(raw) ? raw.filter((k): k is OfferKind => KINDS.includes(k as OfferKind)) : []
    await update($, muted, () => list)
  } catch {
    // Then nothing is muted.
  }
}

const setMuted = async ($: Dollar, list: OfferKind[]): Promise<void> => {
  await update($, muted, () => list)
  try {
    await $.store.set('mutedOffers', list)
  } catch {
    // It holds for this session at least.
  }
}

const muteKind = async ($: Dollar, kind: OfferKind): Promise<void> => {
  const now = await read($, muted)
  if (!now.includes(kind)) await setMuted($, [...now, kind])
  $.ui.toast(say('good', `${OFFER_NAMES[kind]}は、今後出しません。ペインから再開できます。`))
}

const resumeKind = async ($: Dollar, kind: OfferKind): Promise<void> => {
  await setMuted($, (await read($, muted)).filter(k => k !== kind))
  // It may be made again, as if it had not been.
  await update($, seen, s => s.filter(id => id !== kind && !(kind === 'compact' && isEpisodeId(id))))
  $.ui.toast(say('good', `${OFFER_NAMES[kind]}を再開しました。`))
}

/**
 * Puts the next suggestion to the person, if there is one and the moment is right: no turn running,
 * nothing already on screen. A dialog pane first; where the terminal is too narrow for one to be
 * seated, the same suggestion as a card above the band, so it is never lost.
 */
const maybeOffer = async ($: Dollar): Promise<void> => {
  try {
    // With nothing drawn there is nowhere to put a suggestion.
    if (!isHud || isTurnRunning || (await read($, openOffer)) !== null || (await read($, busy)) !== null) return
    // The size of the conversation is a local estimate: learned only when a suggestion would turn on it.
    if (needsConversationSize(await read($, facts))) await refreshUsage($, true)
    // What a one-line suggestion already says is not said again in a dialog: the person would be asked twice, and the answer to one
    // would be counted as the answer to the other.
    const overlapped: OfferKind[] = [...(modeFor('C2') === 'suggest' ? (['compact'] as const) : []), ...(modeFor('C1') === 'suggest' ? (['boundary'] as const) : [])]
    const offer = nextOffer(await offerContext($), await read($, seen), [...(await read($, muted)), ...overlapped])
    if (offer === null) return

    await update($, seen, s => (s.includes(offer.id) ? s : [...s, offer.id]))
    await update($, openOffer, () => ({ id: offer.id, kind: offer.kind, view: 'dialog' }))
    let isPlaced = false
    try {
      isPlaced = (
        await $.ui.open({ id: OFFER_PANE, title: '提案', focus: DIALOG_TAKES_KEYS ? true : undefined, closeOnEscape: true, rows: 12 })
      ).isPlaced
      // A pane left waiting would appear later, when the terminal widens, for a case that has passed.
      if (!isPlaced) await $.ui.close({ id: OFFER_PANE })
    } catch {
      // The card, then.
    }
    if (!isPlaced) await update($, openOffer, o => (o === null ? o : { ...o, view: 'card' as const }))
  } catch {
    // A suggestion is a convenience.
  }
}

/** The person accepts the suggestion on screen. */
const acceptOpen = async ($: Dollar): Promise<void> => {
  const open = await closeOffer($)
  if (open === null) return
  const offer = await offerFor($, open.id)
  if (offer === undefined) {
    $.ui.toast(say('good', '状況が変わったので、今回は見送りました。'))
    return
  }
  await carryOut($, offer)
}

/** The person accepts a suggestion from the pane's list, which may be the one on screen as well. */
const acceptFromPane = async ($: Dollar, offer: Offer): Promise<void> => {
  if ((await read($, openOffer))?.id === offer.id) await closeOffer($)
  await carryOut($, offer)
}

const muteOpen = async ($: Dollar): Promise<void> => {
  const open = await closeOffer($)
  if (open !== null) await muteKind($, open.kind)
}

const muteFromPane = async ($: Dollar, kind: OfferKind): Promise<void> => {
  if ((await read($, openOffer))?.kind === kind) await closeOffer($)
  await muteKind($, kind)
}

/** The prompt is the person's own (at the keyboard, from a remote client, or driving the session), not something sent in. */
const isPerson = (origin: { kind: string } | undefined): boolean =>
  origin === undefined || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'

const later = (id: string) => (d: string[]): string[] => (d.includes(id) ? d : [...d, id])

const FIELD_FOR_TARGET = ['file_path', 'command', 'pattern', 'url', 'query'] as const

const targetOf = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined
  const fields = input as Record<string, unknown>
  for (const key of FIELD_FOR_TARGET) {
    const value = fields[key]
    if (typeof value !== 'string' || value === '') continue
    const line = value.split('\n')[0] ?? value
    if (line.length <= 40) return line
    return key === 'file_path' ? `…${line.slice(-39)}` : `${line.slice(0, 39)}…`
  }
  return undefined
}

// ── The savings layer ──────────────────────────────────────────────────────────────────────────────
// It works from hooks alone, so it is as much at home in `claude -p` as in a terminal; the cat above does not come into it.
// What it decides is in lib/core (pure, and tested apart); what is here is only the asking of `$` and the doing. It is
// in this file because the checker follows `$` only into functions declared in the file it is passed in, and because a
// module may hook an event once: the hooks below call these.

const LEDGER_KEY = 'ledger:v1'
const PERSON_KEY = 'personId'
/** The ledger is written out this long after the last event, and at once when this many wait. */
const FLUSH_MS = 3_000
const FLUSH_AT = 20

const emptySavings: Savings = { digests: 0, tokens: 0, milliUsd: 0, wouldFire: 0, recovered: 0, forks: 0, keptTokens: 0, keptMilliUsd: 0, forkReaders: 0, forkRereads: 0, forkCostMilliUsd: 0, forkLosses: 0 }
const savings = atom({ plugin: 'tokenomics', key: 'savings' } as const, emptySavings)
/** Tokens the output digest has kept out of the conversation today, as the band says them (see `svShow`). */
let savedToday = 0
let keptToday = 0

const sv = freshState(parseOptions(undefined))
let svReady: Promise<void> | null = null
let svFlushTimer: { cancel: () => void } | null = null
let svFlushing: Promise<void> = Promise.resolve()

/** The agents in agents/: offered to the model only while delegation is `auto`. */
const LIGHT_AGENTS: readonly string[] = ['tokenomics:scout', 'tokenomics:test-runner', 'tokenomics:log-digest']

/** What a measure does now. A suggestion is made only to a person at a terminal, and not of a kind that has been given up. */
const modeFor = (id: MeasureId): Mode => {
  const m = modeOf(id, sv.options, sv.arm, sv.canSave)
  return m === 'suggest' && (!sv.isInteractive || sv.retired.includes(id)) ? 'observe' : m
}

/** The version the ledger export names. */
const MOD_VERSION = '0.6.6'

const svInit = async ($: Dollar): Promise<void> => {
  try {
    const session = await $.session.id()
    const stored = await $.store.get(PERSON_KEY)
    let person = typeof stored === 'string' ? stored : ''
    if (person === '') {
      person = `${shortHash(session)}${shortHash(String(await $.clock.now()))}`
      await $.store.set(PERSON_KEY, person)
    }
    sv.arm = armOf(person, sv.options.holdoutPercent)
    sv.sid = sessionKey(session)
    sv.ledger = parseLedger(await $.store.get(LEDGER_KEY))
    // The OS temp folder is the person's own on macOS, where `TMPDIR` points into it; without it the copies would go to a shared /tmp.
    const tmp = await $.env.get('TMPDIR')
    sv.saveDir = handoffDir(tmp, session)
    sv.canSave = tmp !== undefined && tmp !== ''
  } catch {
    // Without them the measures run as for anyone not held back, and the ledger starts empty.
  }
}

/** A reload never sees `session.start`, so whatever needs the session asks for it here, once. */
const svEnsure = ($: Dollar): Promise<void> => (svReady ??= svInit($))

/** Shows today's figures to whoever reads them (the pane), when they have changed. */
const svShow = async ($: Dollar): Promise<void> => {
  const today = savingsToday(sv.ledger, await $.clock.now())
  // A person held back from the savings (to be compared with the rest) is not shown an estimate of them either.
  const next: Savings = sv.arm === 'control' ? { ...today, forks: 0, keptTokens: 0, keptMilliUsd: 0, forkReaders: 0, forkRereads: 0, forkCostMilliUsd: 0, forkLosses: 0 } : today
  const now = await read($, savings)
  if ((Object.keys(next) as (keyof Savings)[]).some(k => now[k] !== next[k])) {
    await update($, savings, () => next)
  }
  // The band says the saved tokens too, and only they redraw it: the pane's other figures change more often, and
  // nothing else redraws the band when the ledger is written. Kept apart from the atom for that reason.
  if (next.tokens !== savedToday || next.keptTokens !== keptToday) {
    savedToday = next.tokens
    keptToday = next.keptTokens
    $.ui.invalidate('ui.render')
  }
}

/** Writes go one after another: two at once would read the same base, and the later would write over the earlier. */
const svFlush = ($: Dollar): Promise<void> => (svFlushing = svFlushing.then(() => svFlushOnce($)).catch(() => undefined))

/** Adds what is waiting to what the store holds, so another session's events are not written over. Never rejects. */
const svFlushOnce = async ($: Dollar): Promise<void> => {
  svFlushTimer?.cancel()
  svFlushTimer = null
  if (sv.pending.length > 0) {
    const batch = sv.pending
    sv.pending = []
    try {
      const merged = batch.reduce(appendRaw, parseLedger(await $.store.get(LEDGER_KEY)))
      await $.store.set(LEDGER_KEY, merged)
      sv.ledger = merged
    } catch {
      // Held for the next try; the memory copy still has them.
      sv.pending = [...batch, ...sv.pending].slice(-200)
    }
  }
  try {
    sv.retired = retiredNudges(sv.ledger, await $.clock.now())
    await svShow($)
  } catch {
    // The figures are for the pane; they can wait.
  }
}

const svSchedule = ($: Dollar): void => {
  svFlushTimer ??= $.clock.after(FLUSH_MS, () => {
    svFlushTimer = null
    void svFlush($)
  })
}

/** Writes one event in the ledger. Never throws: the ledger is for looking back, not for the work. */
const svRecord = async (
  $: Dollar,
  measure: string,
  at: Mode,
  kind: Kind,
  tag?: string,
  n?: Record<string, number>,
  isQuiet = false,
): Promise<void> => {
  try {
    await svEnsure($)
    const raw: RawEvent = {
      kind,
      measure,
      mode: at,
      arm: sv.arm,
      t: await $.clock.now(),
      sid: sv.sid,
      ...(tag === undefined ? {} : { tag }),
      ...(n === undefined ? {} : { n }),
      ...(isQuiet ? { isQuiet } : {}),
    }
    sv.pending.push(raw)
    sv.ledger = appendRaw(sv.ledger, raw)
    if (sv.pending.length >= FLUSH_AT) await svFlush($)
    else svSchedule($)
  } catch {
    // Not recorded.
  }
}

/** Runs one measure's step, failing open: an error or a tripped breaker leaves things as they were. */
const svAttempt = async <T,>($: Dollar, id: MeasureId, step: () => Promise<T>, fallback: T): Promise<T> => {
  if (isTripped(sv.breaker, id)) return fallback
  try {
    const out = await step()
    sv.breaker = succeeded(sv.breaker, id)
    return out
  } catch {
    sv.breaker = failed(sv.breaker, id)
    await svRecord($, id, 'observe', 'error')
    return fallback
  }
}

/** The person did what a suggestion would have said: a compaction, or a fresh start. */
const svAnswered = async ($: Dollar): Promise<void> => {
  // A suggestion that was made and followed is what a suggestion is for; one that only would have been made is agreement.
  if (sv.lastShown !== null && sv.turnIndex - sv.lastShown.turn <= ANSWER_TURNS) {
    await svRecord($, sv.lastShown.measure, 'suggest', 'accepted', 'self')
  } else if (sv.lastWould !== null && sv.turnIndex - sv.lastWould.turn <= ANSWER_TURNS) {
    await svRecord($, sv.lastWould.measure, 'observe', 'accepted', 'self')
  }
  sv.lastShown = null
  sv.lastWould = null
}

/** A moment that would call for a suggestion: queued to be made when the reply ends, or only noted, as the setting says. */
const svMoment = async ($: Dollar, at: Mode, c: Candidate, n: Record<string, number>): Promise<void> => {
  if (at === 'suggest') {
    sv.candidates.push(c)
    return
  }
  sv.lastWould = { measure: c.measure, turn: sv.turnIndex }
  await svRecord($, c.measure, at, 'would', c.tag, n)
}

const stakeOf = (tokens: number | null): number | null => {
  const usd = clearStakeUsd(tokens, sv.mainModel)
  return usd === null ? null : milliUsd(usd)
}

const svStarted = async ($: Dollar, isInteractive: boolean): Promise<void> => {
  resetSession(sv)
  sv.isInteractive = isInteractive
  svReady = svInit($)
  await svReady
  await svRecord($, 'S', 'observe', 'signal', 'start', { holdout: sv.options.holdoutPercent, control: sv.arm === 'control' ? 1 : 0 }, true)
  try {
    sv.retired = retiredNudges(sv.ledger, await $.clock.now())
    await svShow($)
  } catch {
    // The pane shows them when it can.
  }
}

/** The engine's figures: how big the conversation is; a heavy one would have been spoken of. */
const svMeasured = ($: Dollar, tokens: number | undefined, hasLimits: boolean): Promise<void> =>
  svAttempt(
    $,
    'C2',
    async () => {
      await svEnsure($)
      sv.contextTokens = tokens ?? sv.contextTokens
      sv.isSubscription = hasLimits
      const m = modeFor('C2')
      if (m === 'off' || sv.contextTokens === null) return
      const level = heavyLevel(sv.contextTokens, sv.mainModel, sv.isSubscription)
      const rose = risen(sv.latched, level)
      sv.latched = level
      if (rose === null) return
      const c: Candidate = { measure: 'C2', tag: rose, turn: sv.turnIndex, ctx: sv.contextTokens, stakeMilliUsd: stakeOf(sv.contextTokens), needsCold: false }
      await svMoment($, m, c, { ctx: sv.contextTokens, warmMilliUsd: milliUsd(warmTurnUsd(sv.contextTokens, sv.mainModel)) })
    },
    undefined,
  )

/** The person's own prompt: a change of subject, or a return after the cache lapsed, would have been spoken of. */
const svPrompted = ($: Dollar, text: string): Promise<void> =>
  svAttempt(
    $,
    'C1',
    async () => {
      await svEnsure($)
      const now = await $.clock.now()
      const idleMs = sv.lastEndedAt === null ? null : now - sv.lastEndedAt
      sv.lastIdleMs = idleMs
      const ttlMs = cacheTtlMs(sv.options, sv.isSubscription)
      const ctx = sv.contextTokens ?? 0
      if (idleMs !== null) await svRecord($, 'S', 'observe', 'signal', `idle_${idleBucket(idleMs)}_${contextBucket(ctx)}`, undefined, true)
      const c1 = modeFor('C1')
      if (c1 !== 'off') {
        const shift = topicShift({ text, previous: sv.lastPrompt, touched: sv.touched, contextTokens: sv.contextTokens, idleMs, ttlMs })
        if (shift.wouldFire) {
          const c: Candidate = { measure: 'C1', tag: shift.reasons.join('_'), turn: sv.turnIndex, ctx, stakeMilliUsd: stakeOf(sv.contextTokens), needsCold: false }
          await svMoment($, c1, c, { ctx, stakeMilliUsd: c.stakeMilliUsd ?? 0 })
        } else if (shift.isUncertain) {
          await svRecord($, 'C1', c1, 'signal', 'uncertain', { ctx })
        }
      }
      const c3 = modeFor('C3')
      if (c3 !== 'off') {
        const cold = coldReturn(idleMs, ttlMs, sv.contextTokens, sv.mainModel)
        if (cold.isCold) {
          const c: Candidate = { measure: 'C3', tag: contextBucket(ctx), turn: sv.turnIndex, ctx, stakeMilliUsd: cold.penaltyUsd === null ? null : milliUsd(cold.penaltyUsd), needsCold: true }
          await svMoment($, c3, c, { ctx, penaltyMilliUsd: milliUsd(cold.penaltyUsd) })
        }
      }
      sv.lastPrompt = text
    },
    undefined,
  )

/**
 * A subagent's run, once it has ended and its kind is known: what it spent, whether it read files, and, for a skill or agent of
 * this plugin, what it kept out of the conversation. A kind is known when the subagent was spawned as one, or, for a skill's
 * fork, when the Skill call returns (the fork's turn ends first, `svForkStarted`); a run still unnamed when the main turn ends
 * is the kind `custom`.
 */
const svSettle = async ($: Dollar, id: string): Promise<void> => {
  const run = sv.forks.get(id)
  if (run?.ended === undefined) return
  sv.forks.delete(id)
  const m = modeFor('B1')
  if (m === 'off') return
  const type = sv.spawns.get(id)
  const { spent, isReader } = run.ended
  if (type !== undefined && spent !== null) await svRecord($, 'B1', m, 'signal', type, { spent, runs: 1 }, true)
  if (isReader) await svRecord($, 'B1', m, 'signal', `readers_${type ?? 'custom'}`, undefined, true)
  const kept = type === undefined ? null : forkOutcome(run, type)
  if (kept === null) return
  await svRecord(
    $,
    'B1',
    m,
    'signal',
    `kept_${kept.name}`,
    {
      keptTokens: kept.keptTokens,
      readTokens: kept.readTokens,
      reportTokens: kept.reportTokens,
      keptMilliUsd: milliUsd(keptOutUsd(kept.keptTokens, sv.mainModel, ASSUMED_TURNS_AFTER)),
      // What the run itself cost, against what it kept out; a run whose report was as big as what it read kept nothing.
      scoutMicroUsd: kept.runMicroUsd ?? 0,
    },
    true,
  )
  if (kept.isLoss) await svRecord($, 'B1', m, 'outcome', `lost_${type ?? kept.name}`, undefined, true)
}

/** Every run that ended and was never named is settled as it is. */
const svSweep = ($: Dollar): Promise<void> =>
  svAttempt(
    $,
    'B1',
    async () => {
      for (const [id, run] of [...sv.forks]) if (run.ended !== undefined) await svSettle($, id)
    },
    undefined,
  )

/**
 * A skill of this plugin forked: the Skill call's answer names the subagent it ran in, which has usually ended already. Named,
 * its run is settled.
 */
const svForkStarted = ($: Dollar, tool: string, input: Record<string, unknown>, ran: ToolCallResult, agentId: string | undefined): Promise<void> =>
  svAttempt(
    $,
    'B1',
    async () => {
      if (agentId !== undefined || tool !== 'Skill' || ran.deny !== undefined || ran.isError === true) return
      const used = lightUse(tool, input)
      const id = forkedId(ran.result)
      if (used === null || id === null) return
      await svEnsure($)
      sv.spawns.set(id, forkType(used))
      await svSettle($, id)
    },
    undefined,
  )

/** A turn ended: what the cache did, how long the person was away, and what a subagent spent. */
const svTurnDone = ($: Dollar, agentId: string | undefined, usage: TurnUsage | undefined, answer: string): Promise<void> =>
  svAttempt(
    $,
    'C3',
    async () => {
      await svEnsure($)
      if (agentId !== undefined) {
        const isReader = (sv.agentReads.get(agentId)?.size ?? 0) > 0
        if (isReader) sv.agentDone.set(agentId, sv.turnIndex)
        const spent = usage === undefined ? null : usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
        const runUsd = usage === undefined ? null : usageInputUsd(usage)
        const microUsd = runUsd === null ? null : Math.round(runUsd * 1_000_000)
        // Every subagent's run, whatever it is and whatever the delegation setting: its tokens by kind, in its model's family.
        if (usage !== undefined) {
          const used = subagentSpend(usage)
          await svRecord($, 'S', 'observe', 'signal', used.tag, used.n, true)
        }
        sv.forks = forkSet(sv.forks, agentId, forkEnded(sv.forks.get(agentId), { reportTokens: estimateTokens(answer), spent, isReader, turn: sv.turnIndex, microUsd }))
        // Named already (spawned as a kind): settled now. A skill's fork is named when the Skill call returns, which is after this.
        if (sv.spawns.has(agentId)) await svAttempt($, 'B1', () => svSettle($, agentId), undefined)
        return
      }
      sv.turnIndex += 1
      sv.isColdTurn = false
      await svSweep($)
      for (const [id, done] of sv.agentDone) {
        if (sv.turnIndex - done <= ANSWER_TURNS + 2) continue
        sv.agentDone.delete(id)
        sv.agentReads.delete(id)
      }
      sv.lastEndedAt = await $.clock.now()
      if (usage === undefined) return
      sv.mainModel = usage.model
      const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await svRecord(
        $,
        'S',
        'observe',
        'signal',
        'turn',
        { prompt, write: usage.cache_creation_input_tokens, cacheShareMilli: Math.round(cacheShare(usage) * 1000) },
        true,
      )
      sv.isColdTurn = wasCold(usage, sv.lastIdleMs, cacheTtlMs(sv.options, sv.isSubscription))
      if (sv.lastShown !== null && sv.turnIndex - sv.lastShown.turn > ANSWER_TURNS) {
        await svRecord($, sv.lastShown.measure, 'suggest', 'dismissed', 'ignored')
        sv.lastShown = null
      }
      if (sv.isColdTurn) {
        await svRecord($, 'S', 'observe', 'signal', `cold_${contextBucket(prompt)}`, { coldPrompt: prompt, costMilliUsd: milliUsd(coldTurnUsd(prompt, usage.model)) })
      }
      sv.lastIdleMs = null
    },
    undefined,
  )

/** A suggestion in two lengths: `long` as a row of its own after the reply (where there is no card), `short` for the cat's card. */
type NudgeText = { long: string; short: string }

/**
 * The line that ends a reply, if the moment calls for one: the suggestions that arose are weighed against what each would spare
 * (lib/core/nudges), and at most one is made. Those held back are noted as having been wanted. Nothing is typed for the person.
 */
const svNudge = ($: Dollar, usage: TurnUsage | undefined): Promise<NudgeText | undefined> =>
  svAttempt(
    $,
    'C2',
    async () => {
      if (sv.demoNudge) {
        sv.demoNudge = false
        await svRecord($, 'S', 'observe', 'signal', 'nudge_test', undefined, true)
        return { long: DEMO_LINE, short: DEMO_SHORT }
      }
      if (sv.candidates.length === 0) return undefined
      const choice = chooseNudge(sv.candidates, { turn: sv.turnIndex, lastShownTurn: sv.shownAtTurn, isSubscription: sv.isSubscription, isColdTurn: sv.isColdTurn })
      sv.candidates = []
      for (const { candidate: c, why } of choice.held) {
        sv.lastWould = { measure: c.measure, turn: sv.turnIndex }
        await svRecord($, c.measure, 'suggest', 'would', c.tag, { ctx: c.ctx, stakeMilliUsd: c.stakeMilliUsd ?? 0 })
        await svRecord($, 'S', 'observe', 'signal', `held_${why}`, undefined, true)
      }
      if (choice.shown === null) return undefined
      const c = choice.shown
      const prompt = usage === undefined ? 0 : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      // One made and not followed, replaced by the next at the shortest gap, is still one passed over.
      if (sv.lastShown !== null) await svRecord($, sv.lastShown.measure, 'suggest', 'dismissed', 'ignored')
      sv.shownAtTurn = sv.turnIndex
      sv.lastShown = { measure: c.measure, turn: sv.turnIndex }
      await svRecord($, c.measure, 'suggest', 'shown', c.tag, { ctx: c.ctx, stakeMilliUsd: c.stakeMilliUsd ?? 0 })
      const isNoted = sv.options.handoffNote && sv.canSave
      if (c.measure !== 'C3' || usage === undefined) return { long: nudgeLine(c, sv.isSubscription, null, isNoted), short: nudgeShort(c, sv.isSubscription) }
      // This one speaks of the turn that has just ended: how big it was, and what the lapse cost.
      const cost = milliUsd(coldTurnUsd(prompt, usage.model))
      const ended = { ...c, ctx: prompt }
      return { long: nudgeLine(ended, sv.isSubscription, cost, isNoted), short: nudgeShort(ended, sv.isSubscription, cost) }
    },
    undefined,
  )

/** The ledger as the pilot collects it: written to a file beside the saved outputs (where there is such a place), and returned as text. */
const svExport = async ($: Dollar): Promise<string> => {
  await svEnsure($)
  await svFlush($)
  const person = await $.store.get(PERSON_KEY)
  const json = exportLedger(sv.ledger, {
    participant: shortHash(typeof person === 'string' ? person : ''),
    arm: sv.arm,
    options: { ...sv.options },
    version: MOD_VERSION,
  })
  let where = ''
  if (sv.canSave && sv.saveDir !== '') {
    const file = `${sv.saveDir.replace(/\/[^/]+$/, '')}/ledger-export.json`
    try {
      await $.fs.write(file, json)
      where = `\n保存先（記録そのものには書かれません）: ${file}`
    } catch {
      // The text below is the same.
    }
  }
  // The command's output goes into the conversation, and so is read again on every later turn: the record itself goes
  // to the clipboard and the file, and the output only says so. Where neither is possible it is printed, with a word to /clear.
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text: json })).isCopied
  } catch {
    // Printed below if nothing else took it.
  }
  const o = sv.options
  const lines = [
    'tokenomics の記録（件数と合計だけ。記録の中に、プロンプト・ファイル名・パス・コマンド・セッション ID は入っていません）',
    `設定: digest=${o.digest} delegation=${o.delegation} nudges=${o.nudges} holdout=${o.holdoutPercent}% ／ ${sv.ledger.days.length} 日分${where}`,
  ]
  if (isCopied) lines.push('クリップボードにコピーしました。そのまま貼り付けて送れます。')
  if (!isCopied && where === '') lines.push('コピーも保存もできなかったので、下に出します（このあと /clear すると、モデルの文脈からも消えます）。', json)
  return lines.join('\n')
}

/**
 * A model step in which the advisor was asked: each call is counted, with what it read again (`advIn`, an estimate from the
 * step's own figures: the API keeps the advisor's tokens out of them, and its output is not told) and how long it took (`advMs`).
 * A call in a subagent's loop is counted apart. Its own figures are the 推定 ones; they are never added to the exact ones.
 */
const svStepped = async ($: Dollar, agentId: string | undefined, step: TurnStepResult | undefined): Promise<void> => {
  const calls = (step?.serverToolUses ?? []).filter(use => use.name === 'advisor')
  if (calls.length === 0) return
  const read = advisorRead(step?.usage, calls.length)
  for (const call of calls) {
    const ms = advisorMs(call)
    const n = { ...(read === null ? {} : { advIn: read }), ...(ms === null ? {} : { advMs: ms }) }
    await svRecord($, 'S', 'observe', 'signal', agentId === undefined ? 'advisor' : 'advisor_sub', Object.keys(n).length === 0 ? undefined : n)
  }
}

/**
 * After a call of the main conversation: a note this plugin wrote is opened (the Read tool, or a command that shows the file).
 * Counted once per note, by kind, and how many turns after it was written; never where it is. A note this module did not write
 * (it was reloaded since) counts when its place is the plugin's own folder.
 */
const svNoteOpened = ($: Dollar, tool: string, input: Record<string, unknown>, ran: ToolCallResult, agentId: string | undefined): Promise<void> =>
  svAttempt(
    $,
    'C3',
    async () => {
      if (agentId !== undefined || ran.deny !== undefined || ran.isError === true) return
      const opened = noteOpenedBy(tool, input)
      if (opened === null) return
      const known = sv.notes.get(opened.name)
      if (known === undefined && !opened.isInTemp) return
      if (known?.isOpened === true) return
      sv.notes = noteWritten(sv.notes, opened.name, { kind: known?.kind ?? 'other', turn: known?.turn ?? sv.turnIndex, isOpened: true })
      await svRecord(
        $,
        'S',
        'observe',
        'signal',
        `note_read_${known?.kind ?? 'other'}`,
        known === undefined ? undefined : { noteTurns: Math.max(0, sv.turnIndex - known.turn) },
        true,
      )
    },
    undefined,
  )

/**
 * B6: before a tool call of the main conversation. A search it keeps making, a whole test run or a read of a long log is turned back
 * with the light skill named (the note is the answer); the same call made again runs. A subagent's calls are never touched, the ones the
 * skills fork among them. A call of the plugin's own skill is no search; it is counted once it has run (`svLaunched`).
 */
const svSteer = ($: Dollar, tool: string, input: Record<string, unknown>, agentId: string | undefined): Promise<string | undefined> =>
  svAttempt(
    $,
    'B6',
    async () => {
      if (agentId !== undefined) return undefined
      await svEnsure($)
      const m = modeFor('B6')
      if (m === 'off') return undefined
      if (lightUse(tool, input) !== null) return undefined
      const verdict = steerStep(sv.steer, tool, input, sv.turnIndex, m !== 'auto', sv.mainModel)
      sv.steer = verdict.next
      if (verdict.say === 'insist') await svRecord($, 'B6', m, 'outcome', `insisted_${verdict.kind}`)
      if (verdict.say !== 'refuse') return undefined
      await svRecord($, 'B6', m, m === 'auto' ? 'fired' : 'would', verdict.kind, { searches: verdict.searches })

      return m === 'auto' ? steerNote(verdict.kind, verdict.searches, sv.contextTokens) : undefined
    },
    undefined,
  )

/**
 * B6: after a call of the main conversation. A skill or agent of this plugin that started is used; one the engine turned away
 * (a registry out of date, a skill the model may not call) is not, however it was meant. Used soon after a call was turned
 * back, it is the answer to it.
 */
const svLaunched = ($: Dollar, tool: string, input: Record<string, unknown>, ran: ToolCallResult, agentId: string | undefined): Promise<void> =>
  svAttempt(
    $,
    'B6',
    async () => {
      if (agentId !== undefined || ran.deny !== undefined || ran.isError === true) return
      const used = lightUse(tool, input)
      if (used === null) return
      await svEnsure($)
      const m = modeFor('B6')
      if (m === 'off') return
      await svRecord($, 'B6', m, 'signal', `used_${used}`)
      const answered = steerAnswered(sv.steer, sv.turnIndex)
      sv.steer = answered.next
      if (answered.kind !== null) await svRecord($, 'B6', m, 'outcome', `adopted_${answered.kind}`)
    },
    undefined,
  )

/** Before a tool call: the model going back for what a digest cut is noted, and the files the work touches. */
const svWatchCall = async ($: Dollar, tool: string, input: Record<string, unknown>, agentId: string | undefined): Promise<void> => {
  await svEnsure($)
  const m = modeFor('A1')
  // The work changed since an output was cut: running the same command again is the loop of editing and testing, not going back for the rest.
  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) sv.digests.clear()
  // Whether the conversation went back for what was cut is about its own cuts; a subagent running the same command is not that.
  if (m !== 'off' && agentId === undefined) {
    if (tool === 'Bash' && typeof input.command === 'string') {
      const command = shortHash(normalizeCommand(input.command))
      for (const [id, d] of sv.digests) {
        if (d.command === command && sv.turnIndex - d.turn <= 2) {
          sv.digests.delete(id)
          await svRecord($, 'A1', m, 'outcome', 'rerun')
        }
      }
    }
    // A saved output, once however many pieces of it are read (the pointer tells the model to read by offset and limit).
    if (tool === 'Read' && typeof input.file_path === 'string' && sv.saveDir !== '' && isInsideDir(sv.saveDir, input.file_path)) {
      if (isDigestFile(input.file_path) && !sv.readBack.has(input.file_path)) {
        sv.readBack.add(input.file_path)
        await svRecord($, 'A1', m, 'outcome', 'readback')
      }
    }
  }
  if (agentId === undefined) touch(sv, input)
  if (tool === 'Read' && typeof input.file_path === 'string' && modeFor('B1') !== 'off') await svWatchReads($, input.file_path, agentId)
}

/**
 * The quality check on handing work to a subagent: did the main conversation have to read again what the subagent had read?
 * Counted (a file the subagent read, read by the main conversation within a few turns of its finishing) and never kept: the
 * paths live in memory until the session ends.
 */
const svWatchReads = async ($: Dollar, path: string, agentId: string | undefined): Promise<void> => {
  if (agentId !== undefined) {
    const reads = sv.agentReads.get(agentId) ?? new Set<string>()
    if (reads.size < 50) reads.add(path)
    sv.agentReads.set(agentId, reads)
    return
  }
  for (const [id, reads] of sv.agentReads) {
    const done = sv.agentDone.get(id)
    const key = `${id}|${path}`
    if (done === undefined || sv.turnIndex - done > ANSWER_TURNS || !reads.has(path) || sv.rereads.has(key)) continue
    sv.rereads.add(key)
    await svRecord($, 'B1', modeFor('B1'), 'outcome', `reread_${sv.spawns.get(id) ?? 'custom'}`)
  }
}

/** After a Bash call: a large output reaches the model cut down to what it needs, its full text kept in a file. */
const svDigestBash = async (
  $: Dollar,
  toolUseId: string,
  command: string,
  ran: ToolCallResult,
  agentId: string | undefined,
): Promise<ToolCallResult> => {
  await svEnsure($)
  const m = modeFor('A1')
  if (m === 'off') return ran
  if (ran.isError === true) {
    // A failed command (exit code not 0) answers with its text as a string, and the engine refuses an errored answer of any other
    // shape (checked live): it cannot be cut. Counted, so it is known how much of the big output this leaves.
    const chars = typeof ran.text === 'string' ? ran.text.length : 0
    if (chars > DIGEST.overChars) await svRecord($, 'A1', m, 'signal', 'big_error', { chars }, true)
    return ran
  }
  const result = ran.result as Record<string, unknown> | undefined
  const out = typeof result?.stdout === 'string' ? result.stdout : null
  if (out === null || out.length <= DIGEST.overChars) return ran

  // The bigger the share of digests the model went back for, the bigger an output must be to be cut; far too many stops it.
  const threshold = digestThreshold(sv.ledger, await $.clock.now(), DIGEST.overChars)
  const at: Mode = threshold === null ? 'observe' : m
  const path = digestPath(sv.saveDir, toolUseId)
  const cut = digestOutput(out, path, threshold ?? DIGEST.overChars)
  if (cut === null) return ran

  const savedTokens = Math.max(0, estimateTokens(out) - estimateTokens(cut.text))
  const n = {
    inChars: out.length,
    outChars: cut.text.length,
    savedTokens,
    savedMilliUsd: milliUsd(keptOutUsd(savedTokens, sv.mainModel, ASSUMED_TURNS_AFTER)),
  }
  if (agentId !== undefined) {
    // A subagent's output is cut too (its context is the smaller for it) but the conversation would never have read it: counted
    // apart, so it is not in the figure shown as confirmed, and not in what the model going back for a cut output is measured on.
    // What it reads after the cut is in its run's `readTokens` (lib/core/forks).
    if (at === 'auto') {
      await $.fs.write(path, out)
      await svRecord($, 'A1', 'auto', 'signal', 'sub_cut', { subSavedTokens: n.savedTokens }, true)
      return { ...ran, result: { ...result, stdout: cut.text }, text: cut.text } as typeof ran
    }
    return ran
  }
  if (at !== 'auto') {
    // Named apart from the `fired` sums: what was not cut is not counted as spared.
    await svRecord($, 'A1', at, 'would', undefined, { inChars: n.inChars, outChars: n.outChars, wouldTokens: n.savedTokens, wouldMilliUsd: n.savedMilliUsd })
    return ran
  }
  // Written first: a digest whose full text is not saved would lose it, so a failed write leaves the output as it was.
  await $.fs.write(path, out)
  sv.digests.set(toolUseId, { command: shortHash(normalizeCommand(command)), turn: sv.turnIndex })
  await svRecord($, 'A1', 'auto', 'fired', undefined, n)
  return { ...ran, result: { ...result, stdout: cut.text }, text: cut.text } as typeof ran
}

export const register: Register = (on, options) => {
  isHud = parseOptions(options).hud
  sv.options = parseOptions(options)

  on('session.start', async ($, e, next) => {
    resetCat()
    await clearNudge($)
    const likely = await imagesLikely($)
    if (likely !== imageHint) {
      imageHint = likely
      $.ui.invalidate('ui.render')
    }
    await $.command.register({
      name: NAME,
      description: 'トークン消費の分析と、いまやると良い節約を表示します。`/tokenomics settings` で設定（自動要約のタイミングなど）を開きます。',
    })
    await loadMuted($)
    // A model this mod moved in an earlier session whose end was cut short: put it back.
    const back = await restorePending($)
    if (back !== null) $.ui.toast(say('good', `前回切り替えたモデルを ${back} に戻しました。`))
    // A reload forgets the registration but not the switch: put the helper back if it is on.
    if ((await read($, modes)).isWorkerOn) await registerWorker($)
    await refreshUsage($, true)
    await refreshSettings($)
    await svStarted($, e.isInteractive)

    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    // A thumb for the savings: `/tokenomics good` or `/tokenomics bad`. Nothing of the work goes with it.
    const word = e.args.trim().toLowerCase()
    if (word === 'good' || word === 'bad') {
      await svRecord($, 'S', 'observe', 'feedback', word)
      return { text: '記録しました。ありがとうございます（作業の内容は残りません）。' }
    }
    if (word === 'export') return { text: await svExport($) }
    if (word === 'handoff') return { text: await svHandoff($) }
    if (word === 'reset-ledger') {
      sv.ledger = emptyLedger
      sv.pending = []
      try {
        await $.store.delete(LEDGER_KEY)
        await svShow($)
      } catch {
        // The memory copy is already empty.
      }
      return { text: '記録を空にしました（この端末の台帳だけ。ほかには何も残っていません）。' }
    }
    if (word === 'nudge-test') {
      sv.demoNudge = true
      return {
        text: isHud
          ? '次の返信のあと、猫のカードの一言（「小走りです」などが出ている所）に、提案の表示テストが出ます。'
          : '次の返信のあとに、提案の表示テストが一行出ます。',
      }
    }
    const isSettings = word === 'settings' || word === '設定'
    const opened = isHud ? await (isSettings ? openSettings($) : openPane($)) : { isPlaced: false }
    if (opened.isPlaced) return {}

    // Too narrow to seat a pane: say the same thing as text.
    const ctx = await offerContext($)
    if (isSettings) return { text: settingsReport(ctx.facts, activeSavings(ctx.modes, isNoteByDefault()), await read($, muted)) }
    return { text: report(ctx.facts, computeAdvice(ctx.facts), standingOffers(ctx, await read($, muted)), await read($, savings)) }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: `${$.plugin.name}: うまく開けませんでした。もう一度お試しください。` },
  )

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    toolsThisTurn = 0
    requestsThisTurn = []
    sv.steer = steerTurn(sv.steer)
    nudgeCat($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // The engine's own figures are settled once `next` has returned: a suggestion that asks for them sees these.
    const measured = await next(e)
    await change($, f => applyMeasure(f, e))
    await svMeasured($, e.context.tokens, e.rateLimits.length > 0)
    await maybeOffer($)

    return measured
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turns do not enter this conversation's window, but they spend tokens all the same: kept apart.
    if (e.agentId !== undefined) {
      if (e.usage !== undefined) {
        const spent = turnTokens(e.usage).spent
        await change($, f => applyAgentTurn(f, spent))
      }
    } else {
      isTurnRunning = false
      if (e.usage !== undefined) {
        const requests = requestsThisTurn
        const turn = turnTokens(e.usage, requests.map(r => r.input + r.cacheWrite + r.cacheRead))
        requestsThisTurn = []
        const now = await $.clock.now()
        await change($, f => applyTurn(f, turn, now, toolsThisTurn, e.answer.length, isSentInTurn, requests))
        // The first response measures what an empty session holds, which the cat's speed is counted from. The size the engine
        // auto-compacts at, which the gauge counts against, can change under us (/autocompact, a model switch): read again now and then.
        if ((await read($, facts)).baselineTokens === null || now - breakdownAt >= BREAKDOWN_EVERY_MS) await refreshUsage($, true)
        else refreshHeavyLater($)
      }
      nudgeCat($)
      await maybeOffer($)
    }
    await svTurnDone($, e.agentId, e.usage, e.answer)
    const done = await next(e)
    // A one-line suggestion (the reply itself is left as it is). Only a reply that ended in an answer.
    const line = e.agentId === undefined && e.reason === 'answer' ? await svNudge($, e.usage) : undefined
    if (line === undefined) return done
    // With the cat on it stands in the cat's card, in place of the phrase; with it off there is no card, and it is a row after the reply.
    if (!isHud) return { ...done, text: line.long }
    await update($, nudge, () => line.short)
    $.ui.invalidate('ui.render')

    return done
  })

  on('prompt.submit', async ($, e, next) => {
    // A slash command is not a turn, a prompt typed mid-turn belongs to the turn running, and what an agent, a
    // schedule, another session or a finished task sends in is the work going on, not the person moving on.
    if (!e.text.trimStart().startsWith('/') && e.turnId === undefined) {
      const now = await $.clock.now()
      nudgeCat($)
      if (isPerson(e.origin)) {
        isSentInTurn = false
        toolsThisTurn = 0
        requestsThisTurn = []
        await change($, f => applyPrompt(f, now, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens, e.text.length))
        // The person has gone on: a suggestion left on screen is for a moment that has passed.
        await closeOffer($)
        await clearNudge($)
        await svPrompted($, e.text)
      } else {
        // The pause before it counts toward a lapsed cache (a /loop firing after a break reads it all again); no more.
        isSentInTurn = true
        await change($, f => applySentIn(f, now, THRESHOLDS.idleMs, THRESHOLDS.coldCacheContextTokens))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // Before anything is counted or run: a call turned back is neither.
    const note = await svSteer($, String(e.tool), e as unknown as Record<string, unknown>, e.agentId)
    if (note !== undefined) return { deny: note }
    try {
      await svWatchCall($, String(e.tool), e as unknown as Record<string, unknown>, e.agentId)
    } catch {
      // Only a note of what the call touches; the call goes ahead. (Not through the breaker: its successes would hide the digest's failures.)
    }
    const raw = await next(e)
    await svLaunched($, String(e.tool), e as unknown as Record<string, unknown>, raw, e.agentId)
    await svNoteOpened($, String(e.tool), e as unknown as Record<string, unknown>, raw, e.agentId)
    await svForkStarted($, String(e.tool), e as unknown as Record<string, unknown>, raw, e.agentId)
    // A large command output is cut down first, so what is counted below is what the model reads. A subagent's too.
    const ran = e.tool === 'Bash' && raw.deny === undefined ? await svAttempt($, 'A1', () => svDigestBash($, e.tool_use_id, e.command, raw, e.agentId), raw) : raw
    // What a subagent's tool results held is what its report spares the conversation (lib/core/forks).
    if (e.agentId !== undefined && ran.deny === undefined && typeof ran.text === 'string') {
      sv.forks = forkSet(sv.forks, e.agentId, forkRead(sv.forks.get(e.agentId), estimateTokens(ran.text)))
    }
    // What a search handed the conversation, for judging whether the next ones are worth handing over (lib/core/steer).
    if (e.agentId === undefined && ran.deny === undefined && typeof ran.text === 'string' && callKind(String(e.tool), e as unknown as Record<string, unknown>) === 'search') {
      sv.steer = steerSeen(sv.steer, estimateTokens(ran.text))
    }
    if (e.agentId !== undefined || ran.deny !== undefined) return ran

    toolsThisTurn += 1
    nudgeCat($)
    if (e.tool === 'Bash' && ran.isError !== true && isBoundaryCommand(targetOfCommand(e))) {
      await change($, f => applyBoundary(f, 'commit'))
    }

    if (typeof ran.text === 'string') {
      const tokens = estimateTokens(ran.text)
      if (tokens >= THRESHOLDS.bigOutputTokens) {
        const output = { id: e.tool_use_id, tool: String(e.tool), tokens, target: targetOf(e) }
        await change($, f => applyBigOutput(f, output))
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A session picked up after a long pause: the first reply will read the whole conversation again.
  on('classic.SessionStart', async ($, e, next) => {
    const tokens = e.context_tokens ?? 0
    if ((e.source === 'resume' || e.source === 'fork') && e.prompt_cache_likely_expired === true && tokens >= THRESHOLDS.coldCacheContextTokens) {
      const idleMinutes = Math.round((e.seconds_since_last_response ?? 0) / 60)
      await change($, f => applyResume(f, { tokens, usd: e.estimated_cache_write_usd ?? 0, idleMinutes }))
    }

    const done = await next(e)
    if (e.source !== 'clear' && e.source !== 'compact') return done
    const pointer = e.source === 'clear' ? await svClearPointer($, next.budget.remainingMs) : await svCompactPointer($)

    return pointer === undefined ? done : { ...done, additionalContext: [...(done.additionalContext ?? []), pointer] }
  }).catch(($, e, next) => next(e))

  // A change of folder usually means a different piece of work.
  on('classic.CwdChanged', async ($, e, next) => {
    await change($, f => applyBoundary(f, 'cwd'))
    await maybeOffer($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A compaction the person typed, or the engine ran at its threshold: the window shrank, whoever asked.
  // (The band's own button is a plugin call, which does not pass through its own hooks; `compact` above covers it.)
  on('session.compact', async ($, e, next) => {
    const noted = e.agentId === undefined ? await prepareHandoff($, e.trigger, e.instructions, e.messages, next.budget.remainingMs) : e.instructions
    const done = await next(noted === e.instructions ? e : { ...e, instructions: noted })
    // Nothing was installed, so nothing is to be pointed to.
    if (done.skip !== undefined && e.trigger !== 'precompute') compactedNote = null
    // A `precompute` installs nothing: the window has not shrunk. Only a compaction the person typed counts as their answer.
    if (e.agentId === undefined && done.skip === undefined && e.trigger !== 'precompute') {
      await change($, f => applyCompacted(f, done.tokensAfter))
      await clearNudge($)
      jumpCat($)
      if (e.trigger === 'manual') await svAttempt($, 'C2', () => svAnswered($), undefined)
    }

    return done
  }).catch(($, e, next) => next(e))

  // The cap on how hard turns think, once the person has accepted one. Only the main conversation's own
  // steps, and only ever lowering. The effort it asks for is noted, so a suggestion knows what it would lower.
  // The person turns "Reduce motion" on or off in /config: the cat stops, or sets off again.
  on('config.set', { key: 'reduceMotion' }, async ($, e, next) => {
    const done = await next(e)
    if (done.deny === undefined) {
      await change($, f => ({ ...f, isMotionReduced: e.value === true }))
      nudgeCat($)
      $.ui.invalidate('ui.render')
    }

    return done
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    let cap = null
    if (e.agentId === undefined) {
      sv.mainModel = e.model
      const f = await read($, facts)
      if (applyStep(f, e.effort) !== f) await change($, x => applyStep(x, e.effort))
      cap = (await read($, modes)).effort
    }
    const effort = cappedEffort(e.effort, cap)

    const step = yield* next(effort === undefined ? e : { ...e, effort })
    // One request answered: the main loop's turn counts it, with the size of the prompt it sent.
    if (e.agentId === undefined && step?.usage != null) {
      requestsThisTurn.push({
        input: step.usage.input_tokens,
        cacheWrite: step.usage.cache_creation_input_tokens,
        cacheRead: step.usage.cache_read_input_tokens,
        output: step.usage.output_tokens,
        isAdvisor: Array.isArray(step.serverToolUses) && step.serverToolUses.some(u => u.name === 'advisor'),
      })
      // The band and the pane follow the turn as it goes, not only when it ends (the engine measures once a turn).
      const requests = requestsThisTurn
      await change($, f => applyRequest(f, requests, e.model))
    }
    await svStepped($, e.agentId, step)

    return step
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // The light agents the plugin ships (agents/) are heard of by the model only while delegation is `auto`: until then they would
  // be offered with no measurement behind them, and a file-defined agent cannot pin its permission mode, so it takes its parent's.
  on('agent.offer', async ($, e, next) => {
    if (!LIGHT_AGENTS.includes(e.agent)) return next(e)
    await svEnsure($)

    return modeFor('B1') === 'auto' ? next(e) : { isOffered: false }
  }).catch(($, e, next) => next(e))

  // The light helper is registered when the person accepts it, and the model hears of it only while it stays on.
  on('agent.offer', { agent: 'tokenomics:light-worker' }, async ($, e, next) => {
    if (!(await read($, modes)).isWorkerOn) return { isOffered: false }

    return next(e)
  }).catch(() => ({ isOffered: false }))

  // B2: a subagent of a listed kind thinks less.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const lowered = await svAttempt(
      $,
      'B2',
      async () => {
        const m = modeFor('B2')
        if (m === 'off' || e.effort !== undefined) return e
        const type = e.subagent_type ?? 'general-purpose'
        const verdict = decideSpawn(
          { subagentType: type, model: e.model, parentModel: sv.mainModel ?? '', isFork: type === 'fork', isTeammate: false, isWorkflow: false },
          sv.recentSpawns,
          e.description,
          sv.turnIndex,
        )
        if (!verdict.qualifies) return e
        await svRecord($, 'B2', m, m === 'auto' ? 'fired' : 'would', typeTag(type))
        return m === 'auto' ? ({ ...e, effort: 'low' } as typeof e) : e
      },
      e,
    )

    return next(lowered)
  }).catch(($, e, next) => next(e))

  // B1: a subagent of a listed kind runs on a lighter model. Every spawn is noted, to see where the money goes.
  on('agent.spawn', async ($, e, next) => {
    const input = await svAttempt(
      $,
      'B1',
      async () => {
        const m1 = modeFor('B1')
        const verdict = decideSpawn(
          {
            subagentType: e.subagentType,
            model: e.model,
            parentModel: e.parentModel,
            isFork: e.fork,
            isTeammate: e.isTeammate === true,
            isWorkflow: e.workflow !== undefined,
          },
          sv.recentSpawns,
          e.description,
          sv.turnIndex,
        )
        if (verdict.why === 'redelegated') await svRecord($, 'B1', m1, 'signal', `redelegated_${typeTag(e.subagentType)}`)
        const family = modelFamily(e.parentModel) ?? 'unknown'
        await svRecord($, 'B1', m1, 'signal', `${typeTag(e.subagentType).slice(0, 28)}_${family}`, {
          qualifies: verdict.qualifies ? 1 : 0,
          background: e.background ? 1 : 0,
        })
        sv.recentSpawns = [...sv.recentSpawns, { type: e.subagentType, description: e.description, turn: sv.turnIndex }].slice(-20)
        if (!verdict.qualifies || m1 === 'off') return e
        if (m1 === 'auto' && verdict.target !== null) {
          await svRecord($, 'B1', 'auto', 'fired', verdict.target)
          return { ...e, model: verdict.target }
        }
        await svRecord($, 'B1', m1, 'would', verdict.target ?? undefined)
        const m3 = modeFor('B3')
        if (m3 !== 'off' && e.subagentType === 'Explore') await svRecord($, 'B3', m3, 'would', 'Explore')
        return e
      },
      e,
    )
    const started = await next(input)
    if (started.agentId !== undefined) sv.spawns.set(started.agentId, typeTag(e.subagentType))

    return started
  }).catch(($, e, next) => next(e))

  // The model may read what the digest saved without being asked first. Nothing else is let through, and a refusal stands.
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const decided = await next(e)
    if (decided.decision !== 'ask') return decided
    await svEnsure($)
    const path = (e.input as { file_path?: unknown } | null)?.file_path
    if (typeof path !== 'string' || sv.saveDir === '' || !isInsideDir(sv.saveDir, path)) return decided
    // A note it wrote of an earlier conversation is the person's own file in their own temp folder; the digest's setting does not matter.
    if (sv.canSave && isNoteFile(path)) return { decision: 'allow' as const, reason: 'tokenomics: the note it saved of the conversation before' }

    return modeFor('A1') === 'auto' ? { decision: 'allow' as const, reason: 'tokenomics: the full text of an output it shortened' } : decided
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // /clear goes on in the same session; every other end is the end of the switches made in it.
    if (e.reason === 'clear') {
      await change($, applyCleared)
      await clearNudge($)
      jumpCat($)
      await svAttempt($, 'C1', () => svAnswered($), undefined)
      resetConversation(sv)
    } else {
      stopCat()
      await restorePending($)
    }
    await svSweep($)
    await svFlush($)
    // After the ledger is out, so a slow transcript read cannot cost it; the note's own signals follow with a second write.
    if (e.reason === 'clear') {
      await svClearNote($, next.budget.remainingMs)
      await svFlush($)
    }

    return next(e)
  })

  // The person closes the dialog with Escape or its mark: that is "later".
  on('ui.close', { id: OFFER_PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, openOffer, () => null)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Asked before a model switch that would throw away a warm prompt cache.
  on('classic.PreModelSwitch', async ($, e, next) => {
    if (isOwnSwitch) return next(e)
    const isChosen = e.source === 'command' || e.source === 'picker'
    if (isChosen && e.to_model !== e.from_model && e.prompt_cache_warm && e.estimated_cache_write_usd >= THRESHOLDS.modelSwitchUsd) {
      // On a subscription nothing is charged per token: the cost of reading again is the limit it uses up.
      const isSubscription = (await read($, facts)).rateLimits.length > 0
      const cost = isSubscription
        ? `約${formatTokens(e.context_tokens)} tok を読み直すぶん、上限を多く使います。`
        : `読み直しに約${formatUsd(e.estimated_cache_write_usd)}かかります。`
      return {
        permissionDecision: 'ask',
        permissionDecisionReason:
          `いまの会話（約${formatTokens(e.context_tokens)} tok）はキャッシュされています。` +
          `モデルを変えるとそれが使えなくなり、${cost}切り替えますか？`,
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isHud || e.props.hasSurvey) return next(e)

    const f = await read($, facts)
    catFacts = f
    const open = await read($, openOffer)
    const card = open?.view === 'card' ? ((await offerFor($, open.id)) ?? null) : null

    // Only the terminal has a grid of colored cells; elsewhere the band is the plain row.
    const ui = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? (ui as unknown as { Raster: RasterElement }).Raster : null
    // A picture where the terminal is likely to draw one, and has not said it cannot. A reload of the mod in a running
    // session never sees `session.start`, so the terminal's words are read here too, once.
    if (Raster !== null && imageHint === null) imageHint = await imagesLikely($)
    const Image =
      Raster !== null && imageHint === true && catImages !== 'no' && 'Image' in ui ? (ui as unknown as { Image: ImageElement }).Image : null
    const view = catView(f, catState())
    catPhrase = view.phrase
    catAsImage = Image !== null
    if (Raster !== null) {
      catSite = e.requestId
      if (!view.isResting) startCat($, view.periodMs)
      if (Image !== null && catImages === 'maybe' && imageProbe === null) {
        imageProbe = $.clock.after(150, () => void probeImage($))
      }
    }

    return Band({
      ui,
      Raster,
      Image,
      cat: {
        cells: view.isResting || catShown === '' ? catCells(view.look) : catShown,
        png: Image === null ? null : view.isResting || catShownPng === '' ? catPng(view.look) : catShownPng,
        phrase: view.phrase,
      },
      facts: f,
      advice: nextAdvice(f, [...(await read($, dismissed)), ...(modeFor('C3') === 'suggest' ? ['cache-lapse'] : [])]),
      nudge: await read($, nudge),
      savedTokens: savedToday,
      keptTokens: keptToday,
      offer: card,
      tag: tagOf(await read($, modes)),
      isCompacting: (await read($, busy)) === 'compact',
      isWorking: e.props.isWorking,
      columns: e.props.bodyColumns,
      maxRows: e.props.maxRows,
      onAnalysis: () => void openPane($),
      onSettings: () => void openSettings($),
      onAccept: () => void acceptOpen($),
      onLater: () => void closeOffer($),
      onMute: () => void muteOpen($),
      onLaterAdvice: id => void update($, dismissed, later(id)),
    })
  })

  // The dialog: the suggestion on screen, with its three answers.
  on('ui.render', { component: 'Pane', requestId: OFFER_PANE }, async ($, e, next) => {
    if (!isHud) return next(e)
    const ui = $.ui.resolve(e)
    const open = await read($, openOffer)
    const offer = open === null ? undefined : await offerFor($, open.id)
    if (offer === undefined) {
      const { Text } = ui
      return <Text dimColor>いま、提案はありません。</Text>
    }

    return OfferView({
      ui,
      offer,
      keyBase: 'offer-',
      isCard: false,
      isBusy: (await read($, busy)) !== null,
      hasLater: true,
      onAccept: () => void acceptOpen($),
      onLater: () => void closeOffer($),
      onMute: () => void muteOpen($),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!isHud) return next(e)
    const ctx = await offerContext($)
    const ui = $.ui.resolve(e)

    return Pane({
      ui,
      Raster: e.surface === 'terminal' && 'Raster' in ui ? (ui as unknown as { Raster: RasterElement }).Raster : null,
      bodyColumns: e.props.bodyColumns,
      facts: ctx.facts,
      advice: computeAdvice(ctx.facts),
      offers: standingOffers(ctx, await read($, muted)),
      savings: await read($, savings),
      heavy: await read($, heavy),
      isCompacting: (await read($, busy)) === 'compact',
      rows: e.viewport?.rows ?? 24,
      onAccept: offer => void acceptFromPane($, offer),
      onMuteKind: kind => void muteFromPane($, kind),
      onRefresh: () => void refreshUsage($, true),
      onSettings: () => void openSettings($),
      onClose: () => void $.ui.close({ id: PANE }),
    })
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e, next) => {
    if (!isHud) return next(e)
    const ctx = await offerContext($)
    const ui = $.ui.resolve(e)

    return SettingsPane({
      ui,
      Raster: e.surface === 'terminal' && 'Raster' in ui ? (ui as unknown as { Raster: RasterElement }).Raster : null,
      facts: ctx.facts,
      active: activeSavings(ctx.modes, isNoteByDefault()),
      muted: await read($, muted),
      hasCat: catSite !== null && !ctx.facts.isMotionReduced,
      windowAsked: await read($, windowPick),
      isSettingWindow: await read($, isSettingWindow),
      onResume: kind => void resumeKind($, kind),
      onStop: key => void stopSaving($, key),
      onWindowPick: tokens => void update($, windowPick, () => tokens),
      onWindowApply: tokens => void setWindow($, tokens, 'pane'),
      onWindowReset: () => void resetWindow($),
      onCat: demo => peekCat($, demo),
      onAnalysis: () => void openPane($),
      onClose: () => void $.ui.close({ id: SETTINGS_PANE }),
    })
  })
}

/** The command line of a Bash call, whatever its input type says. */
function targetOfCommand(input: unknown): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined
}
