#!/usr/bin/env bash
# Sums the ledger exports of a pilot (`/tokenomics export`) into one report. Needs jq.
#   scripts/ledger-report.sh export-a.json export-b.json ...
set -euo pipefail
[ "$#" -ge 1 ] || { echo "usage: scripts/ledger-report.sh export.json [export.json ...]" >&2; exit 1; }
command -v jq > /dev/null || { echo "jq is needed" >&2; exit 1; }

# An export covers the last 14 days, so a person's weekly exports overlap: two files of one person would be counted twice.
dup="$(jq -s -r 'map(.participant // "?") | group_by(.) | map(select(length > 1) | .[0]) | join(", ")' "$@")"
[ -z "$dup" ] || { echo "同じ参加者の記録が 2 つ以上あります（${dup}）。1 人 1 ファイル（一番新しいもの）にしてください。" >&2; exit 1; }

jq -s -r '
  (map(.days[]?.counts // {} | to_entries[]) | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | from_entries) as $c
  | (map(.days[]?.sums // {} | to_entries[]) | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | from_entries) as $s
  | def n($p): [$c | to_entries[] | select(.key | startswith($p)) | .value] | add // 0;
    def sm($k): $s[$k] // 0;
    def nre($re): [$c | to_entries[] | select(.key | test($re)) | .value] | add // 0;
    def pct($a; $b): if $b == 0 then "-" else (((($a / $b) * 1000) | round) / 10 | tostring) + "%" end;
    def tok($x): if $x >= 1000000 then (($x / 100000 | round) / 10 | tostring) + "M" elif $x >= 1000 then (($x / 100 | round) / 10 | tostring) + "k" else ($x | tostring) end;
    def usd($m): "$" + ((($m / 10 | round) / 100 | tostring) | if test("^[0-9]+$") then . + ".00" elif test("\\.[0-9]$") then . + "0" else . end);
    def nudge($m): "  \($m)  提案 \(n("\($m):shown:")) 回 ・ 実行された \(n("\($m):accepted:suggest")) 回（採用率 \(pct(n("\($m):accepted:suggest"); n("\($m):shown:")))）・ 見過ごされた \(n("\($m):dismissed:suggest:ignored")) 回 ・ 出すはずだった（記録のみ）\(n("\($m):would:observe")) 回、うち本人が自分で実行 \(n("\($m):accepted:observe")) 回";
  [
    "tokenomics 記録の集計",
    "参加者: \(map(.participant) | unique | length) 人 ／ 提案の設定: \(map(.options.nudges // "?") | group_by(.) | map("\(.[0]) \(length)") | join("・")) ／ アーム: \(map(.arm // "?") | group_by(.) | map("\(.[0]) \(length)") | join("・"))",
    "",
    "【出力ダイジェスト】",
    "  縮めた \(n("A1:fired:")) 回 ・ 会話に入れずに済んだ約 \(tok(sm("A1:savedTokens"))) tok（見込み \(usd(sm("A1:savedMilliUsd")))、入力側の価格のみ） ・ 記録のみ（縮めなかった）\(n("A1:would:")) 回（縮めていれば約 \(tok(sm("A1:wouldTokens"))) tok）",
    "  縮められなかった失敗コマンド（終了コードが 0 以外）の大きな出力: \(nre("^A1:signal:[a-z]+:big_error$")) 回",
    "  モデルが取りに戻った割合: \(pct(n("A1:outcome:auto:rerun") + n("A1:outcome:auto:readback"); n("A1:fired:"))) （同じコマンドの打ち直し \(n("A1:outcome:auto:rerun")) ・ 保存ファイルの読み返し \(n("A1:outcome:auto:readback"))。25% を超えたら閾値を上げる）",
    "",
    "【一行の提案（C）】",
    nudge("C1"), nudge("C2"), nudge("C3"),
    "  held back: 金額が小さい \(n("S:signal:observe:held_stake")) ・ 直近に出した \(n("S:signal:observe:held_gap")) ・ 他と重なった \(n("S:signal:observe:held_multi")) ・ 表示テスト \(n("S:signal:observe:nudge_test")) 回",
    "",
    "【サブエージェント（B）】",
    "  起動の記録 \(nre("^B1:signal:[a-z]+:.+_(opus|sonnet|haiku|fable|unknown)$")) 回（うち格下げの対象 \(sm("B1:qualifies")) 回）・ 格下げするはずだった（記録のみ）\(n("B1:would:")) 回 ・ 実際に格下げ \(n("B1:fired:")) 回",
    "  使ったトークン（種類別の合計）: \(tok(sm("B1:spent"))) tok（\(sm("B1:runs")) 回）",
    "  品質の目安（種類ごと。メインが読み直した割合は、サブエージェントが読んだファイルをメインが 3 ターン内に読み直したもの）:",
    (([$c | to_entries[] | .key | capture("^B1:signal:[a-z]+:readers_(?<t>.+)$") | .t] + [$c | to_entries[] | .key | capture("^B1:signal:[a-z]+:redelegated_(?<t>.+)$") | .t]) | unique | if length == 0 then ["    （まだありません）"] else map("    \(.): 読み直し \(nre("^B1:outcome:[a-z]+:reread_\(.)$")) / \(nre("^B1:signal:[a-z]+:readers_\(.)$")) 回（\(pct(nre("^B1:outcome:[a-z]+:reread_\(.)$"); nre("^B1:signal:[a-z]+:readers_\(.)$")))）・ やり直しの依頼 \(nre("^B1:signal:[a-z]+:redelegated_\(.)$")) 回") end | .[]),
    "",
    "【キャッシュ】",
    "  ターン \(n("S:signal:observe:turn")) ・ キャッシュが効いた割合の平均 \(if n("S:signal:observe:turn") == 0 then "-" else (((sm("S:cacheShareMilli") / n("S:signal:observe:turn")) / 10 | round) | tostring) + "%" end)",
    "  冷えた戻り \(n("S:signal:observe:cold_")) 回（書き直しに \(usd(sm("S:costMilliUsd")))）",
    "  戻るまでの空き時間 → 1〜5分 \(n("S:signal:observe:idle_1to5m")) ・ 5〜15分 \(n("S:signal:observe:idle_5to15m")) ・ 15〜60分 \(n("S:signal:observe:idle_15to60m")) ・ 1時間超 \(n("S:signal:observe:idle_gt60m"))",
    "",
    "【評価・不具合】",
    "  👍 \(n("S:feedback:observe:good")) ・ 👎 \(n("S:feedback:observe:bad")) ・ 施策のエラー \([$c | to_entries[] | select(.key | test(":error:")) | .value] | add // 0) 回"
  ] | .[]
' "$@"
