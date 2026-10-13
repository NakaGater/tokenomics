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
# The steering by kind: stopped, then used or insisted on.
echo "$report" | grep -qF "検索 4 → 2 ・ 1 ／ テスト 0 → 0 ・ 0 ／ ログ（0.6.2 から）0 → 0 ・ 0" || { echo "ledger-report.sh: the steering by kind is not as expected" >&2; exit 1; }
# The auto-compact timing: sets from the pane and from the offer, the commands left to the person, who set one, and which sizes.
echo "$report" | grep -qF "ペインから 4 回 ・ 提案から 1 回" && echo "$report" | grep -qF "本人の Enter 待ち）1 回 ・ 設定した人 1 人 / 2 人" && echo "$report" | grep -qF "大きさ別: 200k 1 回 ・ 300k 3 回 ・ 標準 1 回" || { echo "ledger-report.sh: the auto-compact timing section is not as expected" >&2; exit 1; }
# Tokens outside the main conversation, by kind and by model family; the advisor's apart, as an estimate; the notes opened after a summary or a /clear.
echo "$report" | grep -qF "haiku: 6 回 ・ 入力 600 ・ キャッシュ書き込み 12k ・ キャッシュ読み 180k ・ 出力 6k tok" && echo "$report" | grep -qF "呼び出し 3 回（サブエージェントの中で 1 回）・ アドバイザーが読んだ会話（入力の推定）約 400k tok" && echo "$report" | grep -qF "開かれた 1 回（知らせた回数に対して 20%）" && echo "$report" | grep -qF "書かれてから開かれるまで 平均 1.5 ターン後" || { echo "ledger-report.sh: the subagent, advisor and note sections are not as expected" >&2; exit 1; }
# The shape of the requests (0.6.7): an upper bound, set against all the prompts the requests sent; an export from before it adds nothing.
echo "$report" | grep -qF "記録のあるターン 8 ・ メインの会話のリクエスト 80 回（1 ターン平均 10 回）" && echo "$report" | grep -qF "最大 20 回（リクエスト全体の 25%）" && echo "$report" | grep -qF "最大 約 800k tok（全リクエストが読んだ量の 20%）・ うち同じファイルを続けて読んだもの 5 回" && echo "$report" | grep -qF "B6 が止めたリクエスト 4 回 ・ その次のリクエストが読んだ量 約 120k tok（全リクエストが読んだ量の 3%）" || { echo "ledger-report.sh: the request shape section is not as expected" >&2; exit 1; }
# The same person twice (weekly exports overlap) is refused, not counted twice.
if scripts/ledger-report.sh scripts/testdata/ledger-sample-a.json scripts/testdata/ledger-sample-a.json > /dev/null 2>&1; then
  echo "ledger-report.sh: one person in two files must be refused" >&2
  exit 1
fi
