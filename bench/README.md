# ベンチマーク

Mod のオン／オフで、**同じタスクのコスト・ターン数・所要時間・成否**を比べる道具。節約は品質とセットで見る（タスクが解けなくなったら、安くなっても失敗）。

```sh
scripts/bench.sh bench/tasks/fix-failing-test 3 sonnet      # タスク、回数（各アーム）、モデル
BENCH_OPTIONS='{"delegation":"auto"}' scripts/bench.sh bench/tasks/find-definition 5
```

オフとオンを**交互に**実行し（時間によるぶれを均す）、`claude -p` の結果から中央値を出す。結果は `bench/results/`（git には入れない）。`jq` が要る。**実際にモデルを呼ぶので費用がかかる**（1 回 `BENCH_BUDGET_USD`、既定 1 ドルまで）。モデルを呼ばずに道具だけ試すには:

```sh
BENCH_CLAUDE="$PWD/bench/stub-claude.sh" scripts/bench.sh bench/tasks/fix-failing-test 2
```

## タスクの作り方

`bench/tasks/<名前>/` に置く。

| ファイル | 内容 |
|---|---|
| `task.md` | 渡すプロンプト |
| `fixture/` | 作業用のコピー元（実行ごとに一時フォルダへコピーする） |
| `setup.sh` | あれば、コピー後に一時フォルダで実行（社内リポジトリを特定のコミットで clone する、など） |
| `check.sh` | 成否の判定。一時フォルダで実行され、終了コード 0 が成功。モデルの最終回答は `$BENCH_RESULT` のファイルにある |
| `task.tools` | あれば、`--allowedTools` に渡す内容（既定は `Bash Read Edit Write Glob Grep`） |

`claude -p` は許可の確認に答えられないので、タスクが使う道具は `task.tools` で許可する。作業は一時フォルダの中だけで行う。

## 見本

`bench/tasks/` の 3 つは、依存もネットワークも要らない小さな見本（道具が動くことの確認用。本番のタスクは社内リポジトリから選ぶ）: `fix-failing-test`（バグ修正）、`find-definition`（調査）、`summarize-log`（長いログの要約）。

## 測り方の注意

- 比べるのは**中央値**。1 回の値は、キャッシュの温まり方で大きくぶれる。
- 条件を変えて比べる: モデル（`MODEL` 引数）、Mod の設定（`BENCH_OPTIONS`）。LSP あり／なしは、タスクの `setup.sh` で用意する。
- 台帳（`~/.claude/plugins/store/`）にも、ベンチの実行が数字として残る。
