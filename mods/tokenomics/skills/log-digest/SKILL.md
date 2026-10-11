---
name: log-digest
description: 長いログを読んで、エラーと原因だけを短く報告します
argument-hint: "[ログのファイルやコマンド]"
disable-model-invocation: true
context: fork
agent: tokenomics:log-digest
---
Read this log and report what went wrong: $ARGUMENTS
