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

echo "== bench harness (stubbed: no model is called)"
BENCH_CLAUDE="$PWD/bench/stub-claude.sh" scripts/bench.sh bench/tasks/fix-failing-test 2 haiku > /dev/null
# A run that prints nothing has no numbers: it is counted as no_data and shown as "-", never as a blank or a 0.
silent="$(BENCH_CLAUDE=true scripts/bench.sh bench/tasks/fix-failing-test 1 haiku)"
echo "$silent" | grep -Eq '^off +1 +0 +1 +- +- +-$' || { echo "bench.sh: a run with no output is not shown as no_data" >&2; exit 1; }
rm -rf bench/results

echo "== pilot report (on sample exports)"
report="$(scripts/ledger-report.sh scripts/testdata/ledger-sample-a.json scripts/testdata/ledger-sample-b.json)"
echo "$report" | grep -qF "参加者: 2 人" && echo "$report" | grep -qF "採用率 25%" && echo "$report" | grep -qF '$0.80' || { echo "ledger-report.sh: the sample report is not as expected" >&2; exit 1; }
# What was handed to the skills is told as an estimate, apart from the digest's figure, and the arms are set side by side.
echo "$report" | grep -qF "任せた 4 回" && echo "$report" | grep -qF "控えめな推定です" && echo "$report" | grep -qF "control（1 人）" && echo "$report" | grep -qF "treat（1 人）" && echo "$report" | grep -qF "止めた 4 回" && echo "$report" | grep -qF "止めた回数に対して 50%" && echo "$report" | grep -qF "止めるはずだった回数に対して 25%" || { echo "ledger-report.sh: the delegation, steering or arm sections are not as expected" >&2; exit 1; }
# The auto-compact timing: sets from the pane and from the offer, the commands left to the person, who set one, and which sizes.
echo "$report" | grep -qF "ペインから 4 回 ・ 提案から 1 回" && echo "$report" | grep -qF "本人の Enter 待ち）1 回 ・ 設定した人 1 人 / 2 人" && echo "$report" | grep -qF "大きさ別: 200k 1 回 ・ 300k 3 回 ・ 標準 1 回" || { echo "ledger-report.sh: the auto-compact timing section is not as expected" >&2; exit 1; }
# The same person twice (weekly exports overlap) is refused, not counted twice.
if scripts/ledger-report.sh scripts/testdata/ledger-sample-a.json scripts/testdata/ledger-sample-a.json > /dev/null 2>&1; then
  echo "ledger-report.sh: one person in two files must be refused" >&2
  exit 1
fi
