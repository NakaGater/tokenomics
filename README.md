# tokenomics

Claude Code の **Mods**（function hooks プラグイン）を開発・配布するリポジトリ。
リポジトリ自体がマーケットプレイス（`.claude-plugin/marketplace.json`）で、各 Mod は `mods/<name>/` 配下に置く。

## 構成

```
.claude-plugin/marketplace.json   Mod の一覧（配布用）
mods/
  tokenomics/                      スターター Mod（/tokenomics コマンド + ステータス行）
    .claude-plugin/plugin.json
    hooks/hooks.json
    hooks/register.ts
    tests/register.test.ts
    tsconfig.json
scripts/
  sync-types.sh                    claude-code の型宣言を各 Mod に配置（初回 clone 時用）
  check-all.sh                     validate + tsc + test を全 Mod に実行
```

## 前提

- Claude Code 2.1.295 以降（`claude plugin test` / function hooks 対応）
- Bun または Node 20+（`tsc` 実行用。`bun install` で TypeScript を入れる）

## セットアップ

```sh
bun install
scripts/sync-types.sh     # 型宣言を mods/*/.claude-plugin/types/ に配置
scripts/check-all.sh      # validate + 型チェック + テスト
```

## 開発

### 方法 A: `--plugin-dir`（手軽）

```sh
claude --plugin-dir mods/tokenomics
```

保存するたびに hooks モジュールがリロードされる。`/tokenomics` で動作確認できる。

### 方法 B: ローカルマーケットプレイスとして登録

```sh
claude plugin marketplace add .
claude plugin install tokenomics@tokenomics
```

相対パスの `source` で登録した Mod はこのフォルダから直接読まれるので、編集後は `/reload-plugins` で反映される。

### デバッグ

`claude --debug` で、拒否された hook や結果の理由がログに出る。

## 新しい Mod を追加する

1. `mods/<name>/` を `mods/tokenomics/` を参考に作る（plugin.json / hooks.json / register.ts / テスト / tsconfig）
2. `.claude-plugin/marketplace.json` の `plugins` に `{ "name": "<name>", "source": "./mods/<name>" }` を追加
3. `scripts/check-all.sh` を通す

## インストール（配布）

```
/plugin install tokenomics --marketplace NakaGater/tokenomics
```

`y` でマーケットプレイスを追加し、スコープを選ぶとインストールされる。
