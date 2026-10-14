import { expect, test } from 'claude-code/testing'

import { SURFACES, bandProps, engine, measure, paneProps, settingsPaneProps } from './kit'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const run = (args: string) =>
  ({ command: 'tokenomics', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

// The band has a button for each pane; its card and its plain row both carry them.

test('the band has "詳しく分析" and "設定" side by side, in the card and in the plain row', async ($, on) => {
  engine(on)
  await $.session.start(START)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...bandProps(), surface })
    expect((await band.find({ type: 'Button', key: 'analysis' }))?.props.label).toBe('詳しく分析')
    expect((await band.find({ type: 'Button', key: 'settings' }))?.props.label).toBe('設定')
    await band.unmount()
  }
  const plain = await $.ui.mount({ ...bandProps({ bodyColumns: 40 }), surface: 'terminal' })
  expect((await plain.find({ type: 'Button', key: 'analysis' }))?.props.label).toBe('詳しく分析')
  expect((await plain.find({ type: 'Button', key: 'settings' }))?.props.label).toBe('設定')
})

test('each button shows its own pane and takes the other down, so what was pressed is what is seen', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)
  const band = await $.ui.mount({ ...bandProps(), surface: 'terminal' })

  await band.press({ key: 'settings' })
  expect(calls.opened).toEqual(['tokenomics-settings'])
  expect(calls.closed).toEqual(['tokenomics'])
  expect(calls.openArgs.at(-1)?.title).toBe('設定')

  await band.press({ key: 'analysis' })
  expect(calls.opened).toEqual(['tokenomics-settings', 'tokenomics'])
  expect(calls.closed).toEqual(['tokenomics', 'tokenomics-settings'])
  expect(calls.openArgs.at(-1)?.title).toBe('分析')
})

test('/tokenomics opens the analysis, and /tokenomics settings (or 設定) the settings', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  expect((await $.command.run(run(''))).text).toBeUndefined()
  expect(calls.opened).toEqual(['tokenomics'])

  expect((await $.command.run(run('settings'))).text).toBeUndefined()
  expect((await $.command.run(run('設定'))).text).toBeUndefined()
  expect(calls.opened).toEqual(['tokenomics', 'tokenomics-settings', 'tokenomics-settings'])
})

test('where no pane fits, /tokenomics settings answers in text: the size in force, what runs, what is put off', async ($, on) => {
  const calls = engine(on, { isPlaced: false })
  await $.session.start(START)
  await $.session.measure(measure.context(30))

  const ran = await $.command.run(run('settings'))
  expect(calls.opened).toEqual(['tokenomics-settings'])
  expect(ran.text).toContain('トークン消費の設定')
  expect(ran.text).toContain('自動要約のタイミング')
  expect(ran.text).toContain('いま効いている節約')
  // The analysis is not mixed in.
  expect(ran.text).not.toContain('今やること')
  expect(ran.text).not.toContain('いまの状態')
})

// What is in each pane.

test('the analysis pane reads: status, the chart, what is heavy; it has no slider, no stop buttons, no cat, no list of put-off suggestions', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(50))

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...paneProps, surface })
    expect(await pane.find({ type: 'Text', text: 'トークン消費の分析' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'いまの状態' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /直近 \d+ 回のリクエスト/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '重いもの' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '今やること' })).toBeDefined()

    expect(await pane.find({ type: 'Text', text: 'いま効いている節約' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '止めている提案' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: 'Clawd のようす' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '自動要約のタイミング' })).toBeUndefined()
    await pane.unmount()
  }
})

test('the settings pane sets: the auto-compact size, what runs and can be stopped, the cat; it has no status, no chart, no heavy list', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.session.measure(measure.context(50))

  const pane = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '設定' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'いま効いている節約' })).toBeDefined()

  expect(await pane.find({ type: 'Text', text: 'いまの状態' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /直近 \d+ 回のリクエスト/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '重いもの' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '今やること' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '節約のコツ' })).toBeUndefined()
})

test('each pane has a button to the other and one to close itself', async ($, on) => {
  const calls = engine(on)
  await $.session.start(START)

  const analysis = await $.ui.mount({ ...paneProps, surface: 'terminal' })
  expect((await analysis.find({ type: 'Button', key: 'to-settings' }))?.props.label).toBe('設定を開く')
  expect(await analysis.find({ type: 'Button', key: 'to-analysis' })).toBeUndefined()
  await analysis.press({ key: 'to-settings' })
  expect(calls.opened.at(-1)).toBe('tokenomics-settings')
  expect(calls.closed.at(-1)).toBe('tokenomics')

  const settings = await $.ui.mount({ ...settingsPaneProps, surface: 'terminal' })
  expect((await settings.find({ type: 'Button', key: 'to-analysis' }))?.props.label).toBe('分析を開く')
  expect(await settings.find({ type: 'Button', key: 'to-settings' })).toBeUndefined()
  await settings.press({ key: 'to-analysis' })
  expect(calls.opened.at(-1)).toBe('tokenomics')
  expect(calls.closed.at(-1)).toBe('tokenomics-settings')

  await settings.press({ key: 'close' })
  expect(calls.closed.at(-1)).toBe('tokenomics-settings')
  await analysis.press({ key: 'close' })
  expect(calls.closed.at(-1)).toBe('tokenomics')
})
