---
name: test-summary
description: テストを実行して、失敗したものだけを短く報告します（出力が長いとき向け）
argument-hint: "[テストのコマンドや絞り込み]"
disable-model-invocation: true
context: fork
agent: tokenomics:test-runner
---
Run the project's tests and report only the failures. $ARGUMENTS
