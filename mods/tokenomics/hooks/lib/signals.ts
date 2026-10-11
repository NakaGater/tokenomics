// A commit, or a pull request opened or merged, usually ends a piece of work.
const BOUNDARY = /\bgit\s+commit\b|\bgit\s+-C\s+\S+\s+commit\b|\bgh\s+pr\s+(?:create|merge)\b/

/** Whether a Bash command is one that ends a piece of work: what a person would call "done, on to the next". */
export const isBoundaryCommand = (command: unknown): boolean => typeof command === 'string' && BOUNDARY.test(command)
