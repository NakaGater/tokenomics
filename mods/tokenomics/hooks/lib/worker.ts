export const WORKER = 'light-worker'

/** The type the Agent tool dispatches to: `<plugin>:<name>`. */
export const WORKER_TYPE = `tokenomics:${WORKER}`

// English on purpose: the description sits in the model's agent listing every turn it is offered, and costs fewer tokens.
export const WORKER_DESCRIPTION =
  'Cheap read-only helper: finds, reads and summarizes files or logs, then returns a short report. Use for lookups that would otherwise fill your context.'

export const WORKER_PROMPT =
  'You are a read-only research helper. Find and read what the task asks for, then reply with a short report: the answer first, then file paths with line numbers. ' +
  'Never edit or create files and never run a command that changes anything. Keep the report under 20 lines and quote only what is needed.'

// Grep and Glob are named for builds that have them; a native build searches through Bash.
export const WORKER_TOOLS = ['Read', 'Bash', 'Grep', 'Glob'] as const
