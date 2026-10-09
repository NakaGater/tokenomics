# tokenomics — Claude Code mods

This repository is a Claude Code plugin marketplace that holds **mods** (function-hook plugins).
Each mod lives in `mods/<name>/` and is listed in `.claude-plugin/marketplace.json`.

## Layout of one mod

```
mods/<name>/
  .claude-plugin/plugin.json   name, version, description (+ "types" when $.state is used)
  .claude-plugin/types/        laid by the engine on load; gitignored
  hooks/hooks.json             { "modules": ["./register.ts"] }
  hooks/register.ts(x)         export const register: Register = (on, options) => { ... }
  types/index.d.ts             $.state contract (only when the mod keeps state)
  tests/*.test.ts              import { test, expect } from 'claude-code/testing'
  tsconfig.json
```

## Rules

- Before writing or changing a mod, load the `plugin-authoring` skill; its `types/claude-code.d.ts` is the API reference for this build. Grep it for the event or noun at hand.
- Every hook is `($, e, next)`. A guard hook gets `.catch(($, e, next) => next.called ? next(e) : { deny })`.
- No DOM, no Node in a hooks module: reach everything through `$`.
- Adding a mod: create `mods/<name>/`, add its entry to `.claude-plugin/marketplace.json`, add a test, add it to `scripts/check-all.sh` coverage (it globs `mods/*/`).
- Run `scripts/check-all.sh` (validate + tsc + test) before committing.

## Developing

- `claude --plugin-dir mods/<name>` runs a session with the mod loaded and hot-reloaded on save.
- Or register this repo as a local marketplace once (`claude plugin marketplace add .`), install the mod, and use `/reload-plugins` after edits.
- `claude --debug` shows refused hooks and results.

## Test kit gotchas (learned on 2.1.295)

- A test's `on` must answer what the kit does not: `session.start` → `{ cwd: e.cwd }`; op events the mod calls (`command.register`, `tool.register`, `ui.status`, …) → `{ value: ... }` (or `{ deny }`), never a bare value.
- `$.command.run` in a test takes the full input: `{ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen, columns } }`.
- `$.plugin` has only `name` and `root` (no `version`).
- `claude plugin validate` warns on a `command.run` hook without `.catch`; add the guard form.
