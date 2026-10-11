---
name: log-digest
description: Have a cheap agent read a long log file or a command's output and report the errors and their causes in a few lines. Use when a log or output is too long to read in your own context and you need to know what went wrong. Don't use it for short output you can read directly. Pass the file path or the command as the argument.
argument-hint: "[ログのファイルやコマンド]"
context: fork
agent: tokenomics:log-digest
---
Read this log and report what went wrong: $ARGUMENTS
