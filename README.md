# tokenomics

Claude Code の Mod（function hooks プラグイン）を開発・配布するリポジトリ。リポジトリ自体がマーケットプレイスで、いまある Mod は **tokenomics** の 1 つ（版 0.7.2）。

**tokenomics は、トークンの消費を見えるようにして、節約が自然にできるようにする。** 入れたら設定は要らない。

## 画面

プロンプトの上に、枠つきのカードが 1 枚出る。左は Claude Code のキャラクター **Clawd**、右はゲージと数字。

```
╭─────────────────────────────────────────────────────────────────────────────
│                  コンテキスト ▇▇▇▇▇▇▇▁▁▁▁▁▁▁ 52% 83k/160k
│    ▐▗▖███▗▖▙▄     現在のセッションの合計 入力 120k tok  出力 2.4k tok  リクエスト 9 回  ターン 3 回  節約（延べ） 約 38k tok
│    ▐▝▘███▝▘▛▀     現在のターンの合計 入力 8k tok  出力 600 tok  リクエスト 2 回
│   █████████▌      └ キャッシュ読み 6k tok  キャッシュ書き込み 2k tok  キャッシュなし 4 tok
│    ▐▌▀   ▀▐▌      [ 詳しく分析 ]  [ 設定 ]  走っています。区切りで要約か /clear を
╰─────────────────────────────────────────────────────────────────────────────
```

（実際は幅に合わせて折り返す。Clawd は、Ghostty などの画像が描ける端末では画像、ほかの端末ではブロック文字の絵。幅が 56 桁未満の端末とデスクトップ版では、顔 `<[･_･]>` の帯になる。画面のない `claude -p` やクラウドでは何も描かれないが、節約は効く。）

- **ゲージ**は、会話が自動要約の大きさのどこまで来たか。枠の色は、重くなると黄、赤へ。
- **Clawd の動き**で、会話の重さとキャッシュの状態が分かる。
  - 会話が大きいほど速く走り、満杯近くでは汗をかく。
  - 要約したり `/clear` したりすると、ジャンプする。
  - プロンプトキャッシュが切れると、眠る。
- **数字**は、API が数えたとおりの、このセッションの合計と、直近の 1 ターンの合計。**節約（延べ）**は、このプラグインが会話に入れずに済ませたトークン。
- `[ 詳しく分析 ]` と `[ 設定 ]` のボタンで、2 つのペインが開く（`/tokenomics` と `/tokenomics settings`）。

## 入れると起きること

| 何が起きるか | 既定 | 詳しく |
|---|---|---|
| 上のカードを出す | オン（`hud`） | [Clawd](docs/clawd.md)・[数字の意味](docs/numbers.md) |
| 会話が重い・区切りがついた・上限が近い、などの場面で**提案**が出る。受け入れると実行される | 出る | [提案・助言・ペイン](docs/proposals.md) |
| 同じ場面を、返信のあとの**一行の提案**でも伝える | 記録だけ（`nudges`） | [一行の提案](docs/proposals.md#一行の提案) |
| 9,000 文字を超える Bash の出力を、要点だけにして渡す（全文はファイルに残す） | オン（`digest`） | [節約](docs/savings.md#大きなコマンド出力を縮める) |
| `Explore` を軽いモデルで動かす。軽いエージェント・スキルを用意する | 記録だけ（`delegation`） | [節約](docs/savings.md#サブエージェントを軽くする) |
| 検索の重ね・テスト全体・長いログを止めて、軽いスキルを考えさせる | 記録だけ（`steer`） | [節約](docs/savings.md#調査テストログをスキルへ誘導する) |
| 「互いに頼らない読み取りはまとめて頼む」という一文を足す（セッションの半分に。残りは比べるため） | オン（`batch`） | [節約](docs/savings.md#読み取りをまとめて頼む一文) |
| `/clear` と要約の前に、会話の要点をメモに残し、次の会話にその場所を一行だけ伝える | オン（`handoffNote`） | [引き継ぎメモ](docs/handoff.md) |
| 何が効いたかを、**件数と合計だけ**端末に記録する（内容は残さない） | 常に | [台帳](docs/ledger.md) |

「記録だけ」は、効かせずに、効かせたはずの場面の数を台帳に残す。効果を確かめてから `auto` にするための既定。

## コマンド

| コマンド | 意味 |
|---|---|
| `/tokenomics` | 分析ペイン（今やること・いまの状態・今日の節約・重いもの）。幅が足りなければ文字で |
| `/tokenomics settings` | 設定ペイン（自動要約のタイミング・いま効いている節約・止めている提案・Clawd のようす） |
| `/tokenomics handoff` | 要点メモを今すぐ書く。モデルは呼ばないので費用は 0 |
| `/tokenomics export` | 台帳（件数と合計だけ）を JSON でクリップボードにコピーする。パイロットで送る用 |
| `/tokenomics good` / `bad` | 評価を 1 件だけ記録する（作業の内容は残らない） |
| `/tokenomics reset-ledger` | この端末の台帳を空にする |
| `/tokenomics nudge-test` | 次の返信のあとに、一行の提案の見本を 1 回出す |

## 設定（`/config`）

| 項目 | 既定 | 値 |
|---|---|---|
| `hud` Clawd とバンドを表示する | オン | オフにすると、カード・ペイン・提案のカードを出さない（節約は動く） |
| `digest` 大きなコマンド出力を縮める | auto | auto / observe（記録だけ）/ off |
| `delegation` サブエージェントを軽くする | observe | auto / observe / off |
| `steer` 調査・テスト・ログをスキルへ誘導する | observe | auto（止めて考えさせる）/ observe / off |
| `batch` 読み取りをまとめて頼むよう一文を添える | auto | auto（セッションの半分に足す）/ observe / off |
| `nudges` 一行の提案 | observe | suggest（返信のあとに出す）/ observe / off |
| `handoffNote` 会話が消える前にメモを残す | オン | オフなら `/clear` では何も書かず、要約の前も「要約する」の提案を受け入れた人だけに書く |
| `holdoutPercent` 何もしない人の割合 | 0 | 0〜100。効果を測るため、この割合の人には節約を一切せず記録だけにする |
| `cacheTtlMinutes` キャッシュの寿命 | 0（自動） | 分（0〜120）。0 なら API キーは 5 分、サブスクリプションは 60 分 |

## インストール

```sh
claude plugin install tokenomics --marketplace NakaGater/tokenomics
```

セッションの中なら `/plugin install tokenomics --marketplace NakaGater/tokenomics`（こちらは未確認）。Claude Code 2.1.295 で開発・確認している。

## 文書

| 文書 | 内容 |
|---|---|
| [docs/clawd.md](docs/clawd.md) | Clawd の動きの意味・絵・カードの行 |
| [docs/numbers.md](docs/numbers.md) | 帯とペインの数字の意味 |
| [docs/savings.md](docs/savings.md) | 裏で効く節約と、「節約（延べ）」の数え方 |
| [docs/proposals.md](docs/proposals.md) | 提案・助言・一行の提案・ペイン・自動要約のスライダー |
| [docs/handoff.md](docs/handoff.md) | 会話の要点メモ |
| [docs/ledger.md](docs/ledger.md) | 台帳に何が入るか |
| [docs/verified.md](docs/verified.md) | 実機で確かめたこと・まだのこと |
| [docs/development.md](docs/development.md) | 開発の始め方・フォルダの構成・テスト |
| [docs/design/](docs/design/) | 再設計書とパイロットの資料（方針と根拠） |
| [CHANGELOG.md](CHANGELOG.md) | 版ごとの変更 |

開発に加わるときは、まず [docs/development.md](docs/development.md) と、リポジトリの `CLAUDE.md`（Mod の書き方の決まり）を読む。
