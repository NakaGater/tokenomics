#!/usr/bin/env bash
# Runs one benchmark task with the mod off and on, alternating, and prints the medians. See bench/README.md.
#   scripts/bench.sh <task-dir> [runs=3] [model=sonnet]
# BENCH_OPTIONS  the mod's settings for the "on" arm, as JSON (default {})
# BENCH_BUDGET_USD  a ceiling for one run (default 1)
# BENCH_CLAUDE  the command to run instead of `claude` (a stub, to try this script without spending anything)
# BENCH_RESULTS  the folder the results go under (default bench/results)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK="${1:?usage: scripts/bench.sh <task-dir> [runs] [model]}"
RUNS="${2:-3}"
MODEL="${3:-sonnet}"
CLAUDE="${BENCH_CLAUDE:-claude}"
BUDGET="${BENCH_BUDGET_USD:-1}"
OPTIONS="${BENCH_OPTIONS-}"
[ -n "$OPTIONS" ] || OPTIONS='{}'
command -v jq > /dev/null || { echo "jq is needed" >&2; exit 1; }
[ -f "$TASK/task.md" ] && [ -f "$TASK/check.sh" ] || { echo "$TASK needs task.md and check.sh" >&2; exit 1; }

NAME="$(basename "$TASK")"
OUT="${BENCH_RESULTS:-$ROOT/bench/results}/$NAME-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "arm,run,pass,cost_usd,turns,duration_ms" > "$OUT/results.csv"
TOOLS="Bash Read Edit Write Glob Grep"
[ -f "$TASK/task.tools" ] && TOOLS="$(cat "$TASK/task.tools")"

field() {
  local v
  v="$(jq -r "$1" "$2" 2> /dev/null || true)"
  if [ -n "$v" ]; then printf '%s' "$v"; else printf 'NA'; fi
}

run_one() {
  local arm="$1" i="$2" work args pass cost turns dur
  work="$(mktemp -d)"
  [ -d "$TASK/fixture" ] && cp -R "$TASK/fixture/." "$work/"
  [ -f "$TASK/setup.sh" ] && (cd "$work" && bash "$TASK/setup.sh") > /dev/null 2>&1
  args=(-p "$(cat "$TASK/task.md")" --model "$MODEL" --output-format json --max-budget-usd "$BUDGET" --permission-mode acceptEdits --allowedTools "$TOOLS")
  if [ "$arm" = on ]; then
    args+=(--plugin-dir "$ROOT/mods/tokenomics" --settings "{\"pluginConfigs\":{\"tokenomics\":{\"options\":$OPTIONS}}}")
  fi
  (cd "$work" && "$CLAUDE" "${args[@]}" < /dev/null > "$OUT/$arm-$i.json" 2> "$OUT/$arm-$i.err") || true
  jq -r '.result // ""' "$OUT/$arm-$i.json" 2> /dev/null > "$work/.bench-result" || : > "$work/.bench-result"
  if (cd "$work" && BENCH_RESULT="$work/.bench-result" bash "$TASK/check.sh" "$work") > "$OUT/$arm-$i.check" 2>&1; then pass=1; else pass=0; fi
  # A run that printed nothing (or not JSON) has no numbers: NA, left out of the medians and counted as failed, never a blank or a 0.
  cost="$(field '.total_cost_usd // 0' "$OUT/$arm-$i.json")"
  turns="$(field '.num_turns // 0' "$OUT/$arm-$i.json")"
  dur="$(field '.duration_ms // 0' "$OUT/$arm-$i.json")"
  echo "$arm,$i,$pass,$cost,$turns,$dur" >> "$OUT/results.csv"
  rm -rf "$work"
}

median() { grep -v '^NA$' | sort -n | awk '{a[NR]=$1} END {if (NR == 0) print "-"; else if (NR % 2) print a[(NR + 1) / 2]; else print (a[NR / 2] + a[NR / 2 + 1]) / 2}'; }

for i in $(seq 1 "$RUNS"); do
  run_one off "$i"
  run_one on "$i"
done

echo "task: $NAME   runs: $RUNS per arm   model: $MODEL   options: $OPTIONS"
printf '%-4s %5s %7s %7s %12s %8s %12s\n' arm n passed no_data cost_usd turns duration_ms
for arm in off on; do
  rows="$(awk -F, -v a="$arm" '$1 == a' "$OUT/results.csv")"
  n="$(printf '%s\n' "$rows" | grep -c . || true)"
  passed="$(printf '%s\n' "$rows" | awk -F, '$3 == 1' | grep -c . || true)"
  nodata="$(printf '%s\n' "$rows" | awk -F, '$4 == "NA"' | grep -c . || true)"
  printf '%-4s %5s %7s %7s %12s %8s %12s\n' "$arm" "$n" "$passed" "$nodata" \
    "$(printf '%s\n' "$rows" | cut -d, -f4 | median)" "$(printf '%s\n' "$rows" | cut -d, -f5 | median)" "$(printf '%s\n' "$rows" | cut -d, -f6 | median)"
done
echo "(medians of the runs that gave numbers; no_data = runs that printed nothing; the runs are in $OUT)"
