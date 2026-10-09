#!/usr/bin/env bash
# Lays this build's `claude-code` API declarations beside each mod so that
# `tsc -p mods/<name>` works before a session has ever loaded the mod.
# The engine writes the same file (and more) on every load/reload; this
# script only fills the gap on a fresh clone. The folder is gitignored.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)
if [[ -z "$SRC" ]]; then
  echo "No bundled claude-code.d.ts found. Run the /plugin-authoring skill once in a Claude Code session, then retry." >&2
  exit 1
fi

for mod in mods/*/; do
  dest="$mod.claude-plugin/types/claude-code"
  if [[ -f "$dest/index.d.ts" ]]; then
    echo "skip  $mod (engine already laid types)"
    continue
  fi
  mkdir -p "$dest"
  cp "$SRC" "$dest/index.d.ts"
  echo "laid  $mod <- $SRC"
done
