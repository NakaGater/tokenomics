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
    def smre($re): [$s | to_entries[] | select(.key | test($re)) | .value] | add // 0;
    def pct($a; $b): if $b == 0 then "-" else (((($a / $b) * 1000) | round) / 10 | tostring) + "%" end;
    def tok($x): if $x >= 1000000 then (($x / 100000 | round) / 10 | tostring) + "M" elif $x >= 1000 then (($x / 100 | round) / 10 | tostring) + "k" else ($x | tostring) end;
    def usd($m): "$" + ((($m / 10 | round) / 100 | tostring) | if test("^[0-9]+$") then . + ".00" elif test("\\.[0-9]$") then . + "0" else . end);
    def per($a; $b): if $b == 0 then "-" else ((((($a / $b) * 10) | round) / 10) | tostring) end;
    def tally($f): [$f[].days[]? | (.counts // {}) | to_entries[]] | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | from_entries;
    def totals($f): [$f[].days[]? | (.sums // {}) | to_entries[]] | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | from_entries;
    def armLine:
      . as $f
      | tally($f) as $ac
      | totals($f) as $as
      | def an($re): [$ac | to_entries[] | select(.key | test($re)) | .value] | add // 0;
        ($f | length) as $people
      | an("^S:signal:observe:turn$") as $turns
      | "  \($f[0].arm // "?")（\($people) 人）: ターン \($turns) ・ 1 ターンのプロンプト平均 \(if $turns == 0 then "-" else tok((($as["S:prompt"] // 0) / $turns) | round) end) tok ・ 冷えた戻り 100 ターンあたり \(per(an("^S:signal:observe:cold_") * 100; $turns)) 回 ・ 1 人あたり: 縮めた \(per(an("^A1:fired:"); $people)) 回・任せた \(per(an("^B1:signal:[a-z]+:kept_"); $people)) 回・会話に入れずに済んだ推定 約 \(tok((($as["B1:keptTokens"] // 0) / $people) | round)) tok";
    def nudge($m): "  \($m)  提案 \(n("\($m):shown:")) 回 ・ 実行された \(n("\($m):accepted:suggest")) 回（採用率 \(pct(n("\($m):accepted:suggest"); n("\($m):shown:")))）・ 見過ごされた \(n("\($m):dismissed:suggest:ignored")) 回 ・ 出すはずだった（記録のみ）\(n("\($m):would:observe")) 回、うち本人が自分で実行 \(n("\($m):accepted:observe")) 回";
    def batchLine($g; $label):
      n("B7:signal:auto:turns_\($g)") as $t
      | "  \($label): ターン \($t) ・ 1 ターンのリクエスト \(per(sm("B7:reqs_\($g)"); $t)) 回 ・ 呼び出し \(per(sm("B7:calls_\($g)"); $t)) 回 ・ 読み取りが続いたもの \(per(sm("B7:serial_\($g)"); $t)) 回（リクエスト全体の \(pct(sm("B7:serial_\($g)"); sm("B7:reqs_\($g)")))）・ まとめて頼んだもの \(per(sm("B7:parallel_\($g)"); $t)) 回 ・ 1 ターンのプロンプト合計 \(if $t == 0 then "-" else tok((sm("B7:prompt_\($g)") / $t) | round) end) tok";
  [
    "tokenomics 記録の集計",
    "参加者: \(map(.participant) | unique | length) 人 ／ 提案の設定: \(map(.options.nudges // "?") | group_by(.) | map("\(.[0]) \(length)") | join("・")) ／ アーム: \(map(.arm // "?") | group_by(.) | map("\(.[0]) \(length)") | join("・"))",
    "",
    "【出力ダイジェスト（確定）】",
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
    "【任せた調べもの・テスト（B1・推定）】",
    "  任せた \(nre("^B1:signal:[a-z]+:kept_")) 回 ・ 会話に入れずに済んだ読み込み 約 \(tok(sm("B1:keptTokens"))) tok（サブエージェントが読んだ約 \(tok(sm("B1:readTokens"))) tok から、返した報告 約 \(tok(sm("B1:reportTokens"))) tok を引いた分）・ 見込み \(usd(sm("B1:keptMilliUsd")))（入力側の価格のみ。以後 30 ターン読まれる仮定）",
    "  内訳: \(([$c | to_entries[] | .key | capture("^B1:signal:[a-z]+:kept_(?<t>.+)$") | .t] | unique | if length == 0 then ["（まだありません）"] else map("\(.) \(nre("^B1:signal:[a-z]+:kept_\(.)$")) 回") end) | join(" ・ "))",
    "  控えめな推定です（モデルが調べる合間に書く文章は含めません。1 つの質問を 3 回測った限りでは、実際の増え分の 1/2〜1/4 でした）。「確定」の出力ダイジェストの値には足さないでください。",
    "",
    "【調査・テスト・ログをスキルへ（B6）】",
    "  止めた \(n("B6:fired:")) 回 ・ 記録のみ（止めるはずだった）\(n("B6:would:")) 回 ・ 軽いスキル／エージェントが使われた \(nre("^B6:signal:[a-z]+:used_")) 回",
    "  止めたあとに使われた \(nre("^B6:outcome:auto:adopted_")) 回（止めた回数に対して \(pct(nre("^B6:outcome:auto:adopted_"); n("B6:fired:")))）・ 同じ呼び出しを押し通された \(nre("^B6:outcome:auto:insisted_")) 回",
    "  種類別（止めた → 使われた ・ 押し通された）: 検索 \(n("B6:fired:auto:search")) → \(n("B6:outcome:auto:adopted_search")) ・ \(n("B6:outcome:auto:insisted_search")) ／ テスト \(n("B6:fired:auto:test")) → \(n("B6:outcome:auto:adopted_test")) ・ \(n("B6:outcome:auto:insisted_test")) ／ ログ（0.6.2 から）\(n("B6:fired:auto:log")) → \(n("B6:outcome:auto:adopted_log")) ・ \(n("B6:outcome:auto:insisted_log"))",
    "  記録のみの間（止めてはいない）に、止めるはずだった直後に使われた \(nre("^B6:outcome:(observe|suggest):adopted_")) 回（止めるはずだった回数に対して \(pct(nre("^B6:outcome:(observe|suggest):adopted_"); n("B6:would:")))）。これは自然に使われた分で、止めた効果ではありません",
    "",
    "【リクエストの形（推定の上限。記録は 0.6.7 から）】",
    "  記録のあるターン \(n("S:signal:observe:request_shape")) ・ メインの会話のリクエスト \(sm("S:shpReqs")) 回（1 ターン平均 \(per(sm("S:shpReqs"); n("S:signal:observe:request_shape"))) 回）・ うちツールを頼んだもの \(sm("S:shpTools")) 回（頼んだ呼び出しは全部で \(sm("S:shpCalls")) 回。0.6.8 から）",
    "  読み取りを 1 回でまとめて頼んだリクエスト（モデルがもうまとめている分）\(sm("S:shpParallel")) 回",
    "  読み取り 1 つだけのリクエストの直後が、また読み取りだったもの 最大 \(sm("S:shpSerial")) 回（リクエスト全体の \(pct(sm("S:shpSerial"); sm("S:shpReqs")))）・ その直後のリクエストが会話を読み直した量 最大 約 \(tok(sm("S:shpSerialTok"))) tok（全リクエストが読んだ量の \(pct(sm("S:shpSerialTok"); sm("S:shpPromptTok")))）・ うち同じファイルを続けて読んだもの \(sm("S:shpSameFile")) 回",
    "  B6 が止めたリクエスト \(sm("S:shpRefused")) 回 ・ その次のリクエストが読んだ量 約 \(tok(sm("S:shpRefusedTok"))) tok（全リクエストが読んだ量の \(pct(sm("S:shpRefusedTok"); sm("S:shpPromptTok")))）",
    "  読み方: 上限であって、減らせた量ではありません。プラグインには、2 つ目の読み取りが 1 つ目の結果に頼っていたか（読んだ中身で次に読むファイルを決める、など）が見えません。頼っていたものは、まとめて頼めません。読み取りかどうかはエンジンの読み取り専用の判定によります。量はトークン数で、料金の割合ではありません（キャッシュの読み込みは書き込みよりずっと安い）。サブエージェントの分は入りません。ファイル名・コマンドは記録していません。",
    "  B6 が止めるたびに、モデルが止めた旨を読んでもう一度応答するので、リクエストがおよそ 1 つ増えます（目安）。その増えた読み込みの大きさが、上の B6 の行です。止めて得た分と見比べてください。",
    "",
    "【読み取りをまとめて頼む一文（B7・記録は 0.6.8 から）】",
    "  セッション: 一文を足した \(n("B7:fired:auto:session_on")) ・ 足さなかった（比べる側）\(n("B7:signal:auto:session_off")) ・ 足していない設定／何もしない人の分（足すはずだった記録のみ）\(n("B7:would:")) （分け方: セッション ID のハッシュで半々）",
    batchLine("on"; "足した側"),
    batchLine("off"; "足さない側"),
    "  読み方: 同じ人たちの、足した側と足さない側のセッションの比べです（人数・セッション数が少ないうちは目安）。良くなった目印は、リクエストと読み取りが続いたものが減り、呼び出しとプロンプト合計が増えていないことです。呼び出しが増えていたら、読みすぎです。どれだけ差があれば効いたとするかは、まだ決めていません。",
    "  一文は、半分のセッションのシステムプロンプトの末尾に足した 1 節です（モデルが読むだけで、道具も拒否も増えません。1 リクエストあたり約 70 tok、キャッシュ読み）。",
    "",
    "【自動要約のタイミング（記録は 0.6.1 から。ペインのスライダー、提案の「300k にする」）】",
    "  設定された: ペインから \(nre("^S:signal:[a-z]+:window_pane_")) 回 ・ 提案から \(nre("^S:signal:[a-z]+:window_offer_")) 回 ・ 入力欄に入れた（自動で設定できず、本人の Enter 待ち）\(nre("^S:signal:[a-z]+:window_typed_")) 回 ・ 設定した人 \(map(select([.days[]? | (.counts // {}) | keys[] | select(test("^S:signal:[a-z]+:window_(pane|offer)_"))] | length > 0)) | length) 人 / \(length) 人",
    "  大きさ別: \(([$c | to_entries[] | .key | capture("^S:signal:[a-z]+:window_(pane|offer)_(?<t>[0-9]+k|auto)$") | .t] | unique | if length == 0 then ["（まだありません）"] else map("\(if . == "auto" then "標準" else . end) \(nre("^S:signal:[a-z]+:window_(pane|offer)_\(.)$")) 回") end) | join(" ・ "))",
    "  0.6.0 までの記録には、この欄の記録がありません（「まだありません」は、使われていないのではなく、記録されていないだけのことがあります）。設定した人は、1 ターンのプロンプトの平均が下がるので、下のアーム別の比較は割り引いて読んでください。",
    "",
    "【サブエージェントのトークン（確定: API が返した数字。記録は 0.6.3 から）】",
    "  実行 \(nre("^S:signal:observe:sub_[a-z]+$")) 回（メインの会話の外で使われたトークン。どの種類のサブエージェントでも、委任の設定に関わらず数えます）",
    (([$c | keys[] | capture("^S:signal:observe:sub_(?<f>[a-z]+)$") | .f] | unique) as $fams
      | if ($fams | length) == 0 then "  （まだありません）"
        else ($fams[] | . as $f | "  \($f): \($c["S:signal:observe:sub_\($f)"]) 回 ・ 入力 \(tok(sm("S:subIn_\($f)"))) ・ キャッシュ書き込み \(tok(sm("S:subWrite_\($f)"))) ・ キャッシュ読み \(tok(sm("S:subRead_\($f)"))) ・ 出力 \(tok(sm("S:subOut_\($f)"))) tok") end),
    "  モデルの種類（family）ごとに分けています。値段が違うので、種類をまたいで足さないでください。上の【サブエージェント（B）】の「使ったトークン」は、種類が分かる実行だけ・キャッシュ読みを除いた別の数え方です（足さないでください）。",
    "",
    "【アドバイザー（推定）】",
    "  呼び出し \($c["S:signal:observe:advisor"] // 0) 回（サブエージェントの中で \($c["S:signal:observe:advisor_sub"] // 0) 回）・ アドバイザーが読んだ会話（入力の推定）約 \(tok(sm("S:advIn"))) tok ・ 待ち時間の合計 \((sm("S:advMs") / 1000) | round) 秒",
    "  推定の根拠: API は、アドバイザー自身のトークンをプラグインに渡しません。その回の要求の入力（メインの会話の大きさ）から見積もっています。この PC の 33 回では、アドバイザーの入力はその 1.00 倍（0.89〜1.01 倍）、毎回キャッシュなしで丸ごと読み直され、出力は 1 回 約 5〜10k tok（中央値 約 7.5k）でした。出力はプラグインからは見えません。",
    "  メインの会話の数字にも、上のサブエージェントの数字にも足さないでください。",
    "",
    "【要約・/clear のあとに残すメモ（開いた回数は 0.6.3 から）】",
    "  要約のメモ: 書いた \(n("S:signal:observe:compact_note_written")) ・ 一行で知らせた \(n("S:signal:observe:compact_pointer_given")) ・ 開かれた \(n("S:signal:observe:note_read_compaction")) 回（知らせた回数に対して \(pct(n("S:signal:observe:note_read_compaction"); n("S:signal:observe:compact_pointer_given")))）",
    "  /clear のメモ: 書いた \(n("S:signal:observe:clear_note_written")) ・ 一行で知らせた \(n("S:signal:observe:clear_pointer_given")) ・ 開かれた \(n("S:signal:observe:note_read_clear")) 回（知らせた回数に対して \(pct(n("S:signal:observe:note_read_clear"); n("S:signal:observe:clear_pointer_given")))）",
    "  /tokenomics handoff のメモ: 書いた \(n("S:signal:observe:fresh_note_written")) ・ 開かれた \(n("S:signal:observe:note_read_fresh")) 回 ・ 種類が分からないメモ（プラグインの再読み込みのあとなど）が開かれた \(n("S:signal:observe:note_read_other")) 回",
    "  書かれてから開かれるまで 平均 \(per(sm("S:noteTurns"); n("S:signal:observe:note_read_compaction") + n("S:signal:observe:note_read_clear") + n("S:signal:observe:note_read_fresh"))) ターン後（種類をまとめて。0 は同じ返信の中）",
    "  開いた回数は、Read ツールと cat・head・tail・less・sed -n で読んだ分だけです（python などで読んだ分は入りません）。1 つのメモは最初の 1 回だけ数えます。開かれた回数が少ないことは、メモが要らないことなのか、要約が足りていることなのかは、これだけでは分かりません。",
    "",
    "【アーム別の比較（人数が少ないうちは目安。別の人どうしの比較）】",
    (group_by(.arm // "?") | map(armLine) | .[]),
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
