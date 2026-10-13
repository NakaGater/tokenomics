import type { ConfigRow, On, SessionMeasureInput, SessionMessage, SessionUsage } from 'claude-code'
import { mock } from 'claude-code/testing'

import { FACE } from '../hooks/lib/mascot'

export const SURFACES = ['terminal', 'desktop'] as const

export const bandProps = (over: { hasSurvey?: boolean; isWorking?: boolean; bodyColumns?: number; maxRows?: number } = {}) =>
  ({
    plugin: 'tokenomics',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: over.hasSurvey ?? false,
      isWorking: over.isWorking ?? false,
      maxRows: over.maxRows ?? 24,
      bodyColumns: over.bodyColumns ?? 100,
      scroll: { offset: 0, bodyRows: over.maxRows ?? 24 },
      view: {},
    },
  }) as const

/** The suggestion dialog, as the engine asks the mod to draw it. */
export const offerPaneProps = {
  plugin: 'tokenomics',
  component: 'Pane',
  requestId: 'tokenomics-offer',
  props: {
    title: '提案',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
  viewport: { columns: 100, rows: 20 },
} as const

export const paneProps = {
  plugin: 'tokenomics',
  component: 'Pane',
  requestId: 'tokenomics',
  props: {
    title: 'トークン消費',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 100, rows: 40 },
} as const

/** The settings pane, drawn by the same mod under its own id. */
export const settingsPaneProps = {
  ...paneProps,
  requestId: 'tokenomics-settings',
  props: { ...paneProps.props, title: '設定' },
} as const

export type Calls = {
  /** The conversation's own size, apart from the prompt and tools the window holds from the start; change it mid-test. */
  conversation: number
  /** The panes closed, by id. */
  closed: string[]
  /** What each pane was opened with. */
  openArgs: { id: string; title?: string; focus?: true; closeOnEscape?: true }[]
  /** What `$.store` holds now: values kept from an earlier session, and what this one has written. */
  store: Map<string, unknown>
  /** Runs inside `config.set`, before it answers: where a test acts while a switch is under way. */
  beforeSet?: () => Promise<void>
  configSets: { key: string; value: unknown }[]
  agents: { name: string; model?: string; effort?: string | number; tools?: readonly string[]; omitClaudeMd?: true; permissionMode?: string }[]
  writes: { path: string; text: string }[]
  /** The commands the mod ran on the host, by argv, and the time each was given. */
  processes: string[][]
  processTimeouts: (number | undefined)[]
  compactions: { trigger: string; instructions?: string }[]
  steps: { model: string; effort?: string | number; agentId?: string }[]
  clock: ReturnType<typeof mock.clock>
  registered: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  compacts: number
  filled: string[]
  opened: string[]
  usageAsked: number
  /** What the mod repainted in place with `$.ui.blit`, in order: cells for a `Raster`, a PNG (base64) for an `Image`. */
  blits: { requestId: string; key: string; cells: string; png?: string }[]
  /** While true the engine refuses a repaint, as it does for a band that is not on screen. */
  isBlitRefused: boolean
  /** While true the engine refuses a picture (not cells), as it does where the terminal cannot draw one. */
  isImageRefused: boolean
  /** What was put on the clipboard, in order. */
  copied: string[]
  /** While true there is no clipboard to put anything on. */
  isCopyBroken: boolean
  /** The `/autocompact` runs the mod made, in order. */
  commands: { command: string; args: string }[]
}

export type ConfigOptions = {
  autoCompact?: boolean
  isAutoCompactLocked?: boolean
  model?: string
  modelOptions?: string[]
  /** The "Prompt suggestions" row; absent when the build has none. */
  suggest?: boolean | 'absent' | 'locked'
  /** Why `$.config.set` is refused, when it is. */
  setDeny?: string
  /** The "Reduce motion" row: on, off, or absent when the build has none. */
  reduceMotion?: boolean | 'absent'
}

type EngineOptions = {
  config?: ConfigOptions
  /** What `$.store` holds when the session begins: values kept from an earlier one. */
  store?: Record<string, unknown>
  /** TMPDIR, when the environment has one. */
  tmp?: string
  /** More of the environment: what the terminal says of itself (`ORCA_IMAGE_PROTOCOL`, `TMUX`, ...). */
  env?: Record<string, string>
  sessionId?: string
  /** What the transcript holds, for a note to be made from. */
  messages?: SessionMessage[]
  /** What `git status --short --branch` prints; absent, the folder is not a repository. */
  git?: string
  /** Running git fails (it is not installed, or too slow). */
  isGitBroken?: boolean
  /** The size the engine auto-compacts at, and who set it; a size under 400k is the default here, so no suggestion about it arises. `window` is the size it is counted against. */
  autoCompactWindow?: { threshold?: number; source?: string; window?: number }
  /**
   * What `/autocompact` does when the mod runs it: `works` sets the size (and the breakdown then reports it), `ignored` answers and
   * changes nothing, `rejects` is a build that keeps the command to the person.
   */
  autocompactCommand?: 'works' | 'ignored' | 'rejects'
  /** What the API reports for each model step the kit answers (read when the step is answered, so a test may change it between steps). */
  /** The tool calls each step asks for (a test may change it between steps). */
  stepToolUses?: readonly { name: string; input: unknown }[]
  /** Run inside each step the kit answers, before its result returns: the calls the engine starts while the response is still coming in. */
  duringStep?: () => Promise<void>
  stepUsage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }
  /** The tool calls the API ran itself inside each model step the kit answers (the advisor), as the step's result lists them. */
  serverToolUses?: { id: string; name: string; input: unknown; startedAt: number; endedAt?: number }[]
  /** More of what the breakdown lists: memory files, skills, MCP tools, agents, slash commands. */
  breakdownExtras?: Record<string, unknown>
  /** The conversation's own tokens, as the breakdown's Messages row says. */
  conversationTokens?: number
  /** Writing a file fails. */
  isWriteBroken?: boolean
  /** Registering an agent fails. */
  isRegisterBroken?: boolean
  /** What the person has typed in the prompt box. */
  draft?: string
  /** Whether a pane can be seated. */
  isPlaced?: boolean
  /** What `$.session.compact()` comes to. */
  compacted?: { tokensBefore: number; tokensAfter: number } | { skip: string }
  usage?: SessionUsage
}

/** The engine beneath the mod: answers what the kit does not, and records what the mod asked of it. */
export const engine = (on: On, options: EngineOptions = {}): Calls => {
  const calls: Calls = {
    conversation: options.conversationTokens ?? 3_000,
    closed: [],
    openArgs: [],
    store: new Map(Object.entries(options.store ?? {})),
    configSets: [],
    agents: [],
    writes: [],
    processes: [],
    processTimeouts: [],
    compactions: [],
    steps: [],
    clock: mock.clock(on, { now: 1_000_000 }),
    registered: [],
    statuses: [],
    toasts: [],
    compacts: 0,
    filled: [],
    opened: [],
    usageAsked: 0,
    blits: [],
    isBlitRefused: false,
    isImageRefused: false,
    copied: [],
    isCopyBroken: false,
    commands: [],
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    calls.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_$, e) => {
    calls.statuses.push(e.text)
    return { value: undefined }
  })
  // What the engine last measured; `$.session.usage()` answers the same figures, as it does in a session.
  let lastMeasure: SessionMeasureInput | null = null
  on('session.measure', (_$, e) => {
    lastMeasure = e
    return { changed: e.changed }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  // Where the mod yields, the engine draws its own band.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  on('session.end', () => ({ sessionId: 'test' }))

  on('ui.toast', (_$, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  // The panes that are up, as `$.ui.panes()` lists them: opened and placed, not yet closed.
  const up = new Map<string, string>()
  on('ui.panes', () => ({
    value: [...up].map(([id, title]) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', (_$, e) => {
    if (options.isPlaced !== false) up.set(e.id, e.title ?? e.id)
    calls.opened.push(e.id)
    calls.openArgs.push({ id: e.id, title: e.title, focus: e.focus, closeOnEscape: e.closeOnEscape })
    return { value: options.isPlaced === false ? { isPlaced: false, reason: 'too-narrow' } : { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    up.delete(e.id)
    calls.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.blit', (_$, e) => {
    if (calls.isBlitRefused) return { value: { deny: 'not mounted' } }
    if ('source' in e) {
      if (calls.isImageRefused) return { value: { deny: 'the terminal draws no pictures' } }
      calls.blits.push({ requestId: e.requestId, key: e.key, cells: '', png: 'png' in e.source ? e.source.png : undefined })
      return { value: {} }
    }
    calls.blits.push({ requestId: e.requestId, key: e.key, cells: e.cells })
    return { value: {} }
  })
  on('ui.copy', (_$, e) => {
    if (calls.isCopyBroken) return { value: { isCopied: false as const, reason: 'no-clipboard' as const } }
    calls.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.CwdChanged', () => ({}))
  on('classic.SessionStart', () => ({}))

  on('prompt.read', () => ({ value: { text: options.draft ?? '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => {
    calls.filled.push(e.text)
    return { isFilled: true }
  })

  on('session.compact', (_$, e) => {
    calls.compacts += 1
    calls.compactions.push({ trigger: e.trigger, instructions: e.instructions })
    const done = options.compacted ?? { tokensBefore: 160_000, tokensAfter: 40_000 }
    return 'skip' in done ? done : { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], ...done }
  })
  on('store.get', (_$, e) => ({ value: calls.store.get(e.key) }))
  on('store.set', (_$, e) => {
    calls.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    calls.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...calls.store.keys()] }))
  mock.env(on, { ...(options.tmp === undefined ? {} : { TMPDIR: options.tmp }), ...options.env })
  on('session.id', () => ({ value: options.sessionId ?? 'sess-1' }))
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('process.run', (_$, e) => {
    calls.processes.push([...e.argv])
    calls.processTimeouts.push(e.init?.timeoutMs)
    if (options.isGitBroken) throw new Error('git is slow')
    const base = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    return { value: options.git === undefined ? { ...base, exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : { ...base, exitCode: 0, stdout: options.git } }
  })
  on('fs.write', (_$, e) => {
    if (options.isWriteBroken) throw new Error('disk full')
    calls.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })

  // The /config rows the pane acts on; a set changes the row, as the menu would.
  const config = {
    autoCompact: options.config?.autoCompact ?? true,
    model: options.config?.model ?? 'opus',
    suggest: options.config?.suggest === true,
    reduceMotion: options.config?.reduceMotion === true,
  }
  // The size `/autocompact` set, when it did: the breakdown reports it, with the engine's 33k kept back before it is full.
  let setWindow: number | 'auto' | null = null
  on('command.run', { command: 'autocompact' }, (_$, e) => {
    calls.commands.push({ command: e.command, args: e.args })
    if (options.autocompactCommand === 'rejects') throw new Error('no such command')
    if (options.autocompactCommand !== 'ignored') setWindow = e.args === 'auto' ? 'auto' : Number.parseInt(e.args, 10) * 1000
    return { text: `Auto-compact window: ${e.args}` }
  })
  on('session.usage', () => {
    calls.usageAsked += 1
    return {
      value:
        options.usage ??
        ({
          startedAt: 0,
          rateLimits: lastMeasure?.rateLimits ?? [],
          ...(lastMeasure?.cost === undefined ? {} : { cost: lastMeasure.cost }),
          context: {
            window: lastMeasure?.context.window ?? 200_000,
            percent: lastMeasure?.context.percent,
            tokens: lastMeasure?.context.tokens,
            breakdown: {
              categories: [
                { name: 'System prompt', tokens: 2000, color: 'x', kind: 'used' },
                { name: 'Messages', tokens: calls.conversation, color: 'x', kind: 'used' },
                { name: 'Free space', tokens: 150_000, color: 'x', kind: 'free' },
              ],
              isAutoCompactEnabled: config.autoCompact,
              autoCompactThreshold:
                typeof setWindow === 'number'
                  ? setWindow - 33_000
                  : setWindow === 'auto'
                    ? (lastMeasure?.context.window ?? 200_000) - 33_000
                    : options.autoCompactWindow === undefined
                      ? 160_000
                      : options.autoCompactWindow.threshold,
              autocompactSource: typeof setWindow === 'number' ? 'settings' : setWindow === 'auto' ? 'auto' : (options.autoCompactWindow?.source ?? 'auto'),
              rawMaxTokens: typeof setWindow === 'number' ? setWindow : setWindow === 'auto' ? (lastMeasure?.context.window ?? 200_000) : (options.autoCompactWindow?.window ?? lastMeasure?.context.window ?? 200_000),
              maxTokens: typeof setWindow === 'number' ? setWindow : setWindow === 'auto' ? (lastMeasure?.context.window ?? 200_000) : (options.autoCompactWindow?.window ?? lastMeasure?.context.window ?? 200_000),
              memoryFiles: [],
              mcpTools: [],
              agents: [],
              ...options.breakdownExtras,
            },
          },
        } as unknown as SessionUsage),
    }
  })
  on('config.list', () => ({
    value: [
      {
        key: 'autoCompact',
        label: 'Auto-compact',
        kind: 'boolean',
        value: config.autoCompact,
        provider: { plugin: 'engine', tier: 'core' },
        isLocked: options.config?.isAutoCompactLocked ?? false,
      },
      ...(options.config?.suggest === 'absent'
        ? []
        : [
            {
              key: 'promptSuggestionEnabled',
              label: 'Prompt suggestions',
              kind: 'boolean',
              value: config.suggest,
              provider: { plugin: 'engine', tier: 'core' },
              isLocked: options.config?.suggest === 'locked',
            },
          ]),
      ...(options.config?.reduceMotion === 'absent'
        ? []
        : [
            {
              key: 'reduceMotion',
              label: 'Reduce motion',
              kind: 'boolean',
              value: config.reduceMotion,
              provider: { plugin: 'engine', tier: 'core' },
              isLocked: false,
            },
          ]),
      {
        key: 'model',
        label: 'Model',
        kind: 'choice',
        value: config.model,
        options: options.config?.modelOptions ?? ['default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]'],
        provider: { plugin: 'engine', tier: 'core' },
        isLocked: false,
      },
    ] as ConfigRow[],
  }))
  on('config.set', async (_$, e) => {
    await calls.beforeSet?.()
    calls.configSets.push({ key: e.key, value: e.value })
    if (options.config?.setDeny !== undefined) return { deny: options.config.setDeny }
    if (e.key === 'autoCompact') config.autoCompact = Boolean(e.value)
    if (e.key === 'model') config.model = String(e.value)
    if (e.key === 'promptSuggestionEnabled') config.suggest = Boolean(e.value)
    if (e.key === 'reduceMotion') config.reduceMotion = Boolean(e.value)
    return { value: e.value }
  })

  on('agent.register', (_$, e) => {
    if (options.isRegisterBroken) throw new Error('not bound')
    calls.agents.push({ name: e.name, model: e.model, effort: e.effort, tools: e.tools, omitClaudeMd: e.omitClaudeMd, permissionMode: e.permissionMode })
    return { value: { agent: `tokenomics:${e.name}` } }
  })
  on('agent.offer', () => ({ isOffered: true }))

  on('turn.step', async function* (_$, e) {
    calls.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    await options.duringStep?.()
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: options.stepToolUses ?? [],
      ...(options.serverToolUses === undefined ? {} : { serverToolUses: options.serverToolUses }),
      stopReason: 'end_turn' as const,
      usage: options.stepUsage ?? { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model },
    }
  })

  return calls
}

/** Raises one model step and reads it to its end, as the engine does. */
export const runStep = async (
  $: { turn: { step: (e: never) => AsyncGenerator<unknown> & { readonly result: Promise<unknown> } } },
  step: { model?: string; effort?: string | number; agentId?: string } = {},
): Promise<void> => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...step } as never)
  for await (const _chunk of stream) {
    // Nothing to read: the bottom streams no chunks.
  }
  await stream.result
}

export const measure = {
  context: (percent: number, window = 200_000) => ({
    context: { window, percent, tokens: Math.round((window * percent) / 100) },
    rateLimits: [],
    changed: ['context'] as ['context'],
  }),
}

/** A model switch the engine is about to make, as `classic.PreModelSwitch` carries it. */
export const MODEL_SWITCH = {
  from_model: 'claude-opus-5-5',
  to_model: 'claude-sonnet-5-5',
  requested_model: 'sonnet',
  source: 'command',
  context_tokens: 120_000,
  prompt_cache_warm: true,
  cache_ttl: '5m',
  estimated_cache_write_usd: 0.9,
  pricing: 'catalog',
} as const

/** The person answers the suggestion on screen as a dialog: `accept`, `later` or `mute`. */
export const answer = async (
  $: { ui: { mount: (target: never) => Promise<{ press: (t: { key: string }) => Promise<unknown>; unmount: () => Promise<void> }> } },
  choice: 'accept' | 'later' | 'mute',
): Promise<void> => {
  const dialog = await $.ui.mount({ ...offerPaneProps, surface: 'terminal' } as never)
  await dialog.press({ key: `offer-${choice}` })
  await dialog.unmount()
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/=+$/, '')
  const bytes: number[] = []
  let bits = 0
  let held = 0
  for (const ch of clean) {
    held = (held << 6) | ALPHABET.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((held >> bits) & 255)
    }
  }
  return Uint8Array.from(bytes)
}

/** The cells of a `Raster` as they were packed: glyph and both colors of each, row-major. */
export const decodeCells = (packed: string): { ch: string; fg: number; bg: number }[] => {
  const bytes = fromBase64(packed)
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
  const cells: { ch: string; fg: number; bg: number }[] = []
  for (let i = 0; i < words.length; i += 3) {
    cells.push({ ch: String.fromCodePoint(words[i] ?? 32), fg: words[i + 1] ?? 0, bg: words[i + 2] ?? 0 })
  }
  return cells
}

/** The colour of the band's frame: the card is the one round box the band draws (a suggestion's own card is drawn beside it). */
export const frameColor = async (ui: { findAll: (t: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }): Promise<unknown> =>
  (await ui.findAll({ type: 'Box' })).find(b => b.props.borderStyle === 'round')?.props.borderColor

type TextFinder = { findAll: (t: { type: string }) => Promise<{ text?: string; props: Record<string, unknown> }[]> }

/** What the one-line suggestion says in the band: the Text in the claude color that is not the plain row's face (the card's frame is a Box). */
export const nudgeIn = async (ui: TextFinder): Promise<string | undefined> =>
  (await ui.findAll({ type: 'Text' })).find(t => t.props.color === 'claude' && !Object.values(FACE).includes(t.text ?? ''))?.text

/** What the cat's phrase says in the card: the dim Text that is not the label of a figure or a limit. */
export const phraseIn = async (ui: TextFinder): Promise<string | undefined> =>
  (await ui.findAll({ type: 'Text' })).find(t => t.props.dimColor === true && !/^(?:コンテキスト|今回|今回（1ターンの合計）|リクエスト|出力|└ キャッシュ読み|キャッシュ書き込み|キャッシュなし|エージェント|節約|委任（推定）|累計|.*の上限)$/.test(t.text ?? ''))?.text

/** What the band says the digest has saved today: the figure beside the dim label "節約", or undefined where it says nothing. */
export const savedIn = async (ui: TextFinder): Promise<string | undefined> => {
  const texts = await ui.findAll({ type: 'Text' })
  const label = texts.find(t => t.text === '節約' && t.props.dimColor === true)
  return label === undefined ? undefined : texts.find(t => t.props.color === 'success')?.text
}

/** What the band says work handed to the plugin's skills and agents kept out today: the figure after the dim label "委任（推定）", or undefined. */
export const keptIn = async (ui: TextFinder): Promise<string | undefined> => {
  const texts = await ui.findAll({ type: 'Text' })
  const at = texts.findIndex(t => t.text === '委任（推定）' && t.props.dimColor === true)
  return at < 0 ? undefined : texts.slice(at + 1).find(t => t.props.color === 'success')?.text
}
