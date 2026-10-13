---
name: test-summary
description: Run the project's tests or build in a cheap agent and get back only the failures. Use when a full test or build run would print long output and you only need to know what failed and why. Don't use it when you need the full output, or for one quick test you can run yourself. Pass a command or a filter as the argument, or nothing for the project's usual one.
argument-hint: "[テストのコマンドや絞り込み]"
context: fork
agent: tokenomics:test-runner
---
Run the project's tests and report only the failures. $ARGUMENTS
