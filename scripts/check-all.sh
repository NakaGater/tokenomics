#!/usr/bin/env bash
# Validate, type-check and test every mod under mods/.
set -euo pipefail
cd "$(dirname "$0")/.."

claude plugin validate .
for mod in mods/*/; do
  echo "== $mod"
  claude plugin validate "$mod"
  bunx tsc -p "$mod"
  claude plugin test "$mod"
done
