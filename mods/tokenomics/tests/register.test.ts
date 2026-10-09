import { expect, test } from 'claude-code/testing'

test('session.start registers /tokenomics, sets the status line, and the command answers', async ($, on) => {
  // The engine beneath the plugin: a test answers what the kit does not.
  const registered: string[] = []
  const statuses: (string | undefined)[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['tokenomics'])
  expect(statuses).toEqual(['tokenomics: ready'])

  const ran = await $.command.run({
    command: 'tokenomics',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(ran.text).toBe('tokenomics is loaded.')
})
