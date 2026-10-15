# 開発

← [README](../README.md)

## 前提

- Claude Code。2.1.295 で開発・確認している（最低の版を強制する仕組みはない。設計書は基準線を v2.1.287 としている）
- Bun（`check-all.sh` が `bunx tsc` を使う。`bun install` で TypeScript が入る）、`jq`（ベンチの道具と台帳の集計に要る）、bash

## 最初の一回

```sh
bun install
claude --plugin-dir mods/tokenomics   # 一度読み込む。エンジンが型宣言を .claude-plugin/types/ に全部書く
scripts/check-all.sh                  # validate + 型チェック + テスト
```

型宣言（`.claude-plugin/types/`、git には入れない）はエンジンが書く。読み込む前に置きたいときは `scripts/sync-types.sh` があるが、これは `plugin-authoring` スキルを一度動かしたあとの一時フォルダ（macOS の `/private/tmp/claude-*/bundled-skills/…`）から `claude-code/index.d.ts` だけをコピーする。ツールの型（`claude-code-tools/`）などは置かないので、これだけで `tsc` が通るかは確かめていない。

## 動かしながら作る

**方法 A: `--plugin-dir`（手軽）**

```sh
claude --plugin-dir mods/tokenomics
```

保存するたびに hooks モジュールが読み込み直される。`/tokenomics` で確かめる。

**方法 B: ローカルのマーケットプレイスとして登録**

```sh
claude plugin marketplace add .
claude plugin install tokenomics@tokenomics
```

相対パスの `source` で登録した Mod は、このフォルダから直接読まれる。編集したら `/reload-plugins`。

**デバッグ:** `claude --debug` で、拒否された hook とその理由が出る。

## コミットの前に

```sh
scripts/check-all.sh
```

Mod ごとの `claude plugin validate`、`tsc`、`claude plugin test`、ベンチの道具（モデルを呼ばない見本で動かす）、パイロット集計の確かめを、まとめて流す。テストだけなら、リポジトリの直下で次のとおり（Mod のフォルダの中からは動かない）。

```sh
claude plugin test mods/tokenomics
```

## フォルダの構成

```
.claude-plugin/marketplace.json   Mod の一覧（配布用）
mods/tokenomics/
  .claude-plugin/plugin.json      名前・版・設定の項目（userConfig）
  .claude-plugin/types/           エンジンが書く型宣言（git には入れない）
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              イベントの配線。$ に触れる処理はすべてここ
  hooks/lib/                      判定・整形・Clawd の絵と速さ・メモなどの純粋関数
  hooks/lib/core/                 節約の層（設定・価格・モード・台帳・出力ダイジェスト・サブエージェント・提案の判定）
  hooks/lib/cat-art.ts            Clawd の画像（生成物。手で直さない。`tools/clawd/make-clawd.ts` で作り直す）
  hooks/ui/                       帯とペインの描画
  agents/  skills/                軽いエージェント（scout・test-runner・log-digest）と、それを呼ぶスキル
  tools/clawd/                    Clawd の画像を作る道具
  types/index.d.ts                $.state の契約
  tests/                          ロジックのテストと、エンジンを通した UI のテスト
bench/                            ベンチのタスクの置き場と、試験用の見本（bench/README.md）
docs/design/                      再設計書とパイロットの資料
scripts/
  sync-types.sh                   型宣言を各 Mod に置く（上の注意を読むこと）
  check-all.sh                    validate + tsc + test を全 Mod に流す。ベンチの道具と台帳の集計の確かめも含む（モデルは呼ばない）
  bench.sh                        タスクを Mod オフ／オンで交互に流し、中央値を比べる。**実際にモデルを呼ぶので費用がかかる**（1 回 `BENCH_BUDGET_USD`、既定 1 ドルまで）
  ledger-report.sh                台帳の書き出し（`/tokenomics export`）を集計する（`jq` が要る）
```

hooks のモジュールには、DOM も Node もない。外の世界にはすべて `$` から触る。

## テストの書き方で気をつけること

- テストの `on` は、キットが答えないものに答える。`session.start` は `{ cwd: e.cwd }`。Mod が呼ぶ操作の事象（`command.register`、`tool.register`、`ui.status` など）は `{ value: ... }`（または `{ deny }`）で返す。値をそのまま返してはいけない。
- テストの `$.command.run` には、入力を全部渡す: `{ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen, columns } }`。
- `$.plugin` にあるのは `name` と `root` だけ（`version` はない）。
- `command.run` の hook には、`.catch(($, e, next) => next.called ? next(e) : { deny })` の形の守りを付ける。付けないと `claude plugin validate` が警告する。
- 時間に頼るテストは、時計を進めて確かめる。Clawd の「キャッシュが切れて眠る」も同じ。

## 新しい Mod を足す

1. `mods/<name>/` を、`mods/tokenomics/` を手本に作る（`plugin.json`・`hooks.json`・`register.ts(x)`・テスト・`tsconfig.json`。`$.state` を使うなら `types/index.d.ts` も）。
2. `.claude-plugin/marketplace.json` の `plugins` に `{ "name": "<name>", "source": "./mods/<name>" }` を足す。
3. `scripts/check-all.sh` を通す（`mods/*/` を順に拾う）。ただし `package.json` の `typecheck` と `test` は `mods/tokenomics` に決まっているので、新しい Mod の分は足す。

## ベンチとパイロット

- ベンチ: `scripts/bench.sh` と `bench/README.md`。
- パイロット（数人に使ってもらって効果を測る）: `docs/design/pilot-plan.md`、`docs/design/pilot-kit.md`。集計は `scripts/ledger-report.sh export-*.json`。
- 設計の方針と根拠: `docs/design/tokenomics-redesign.md`。
