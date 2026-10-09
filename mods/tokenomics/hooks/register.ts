import type { Register } from 'claude-code'

const COMMAND = 'tokenomics'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show that the tokenomics mod is loaded.',
    })
    $.ui.status('tokenomics: ready')

    return next(e)
  })

  on('command.run', { command: COMMAND }, $ => ({
    text: `${$.plugin.name} is loaded.`,
  })).catch(($, e, next) =>
    next.called ? next(e) : { text: `${$.plugin.name}: the command failed.` },
  )
}
