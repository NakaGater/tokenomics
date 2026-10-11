---
name: scout
description: コードの調査を軽いエージェントに任せて、短い報告だけを受け取ります
argument-hint: "[調べたいこと]"
disable-model-invocation: true
context: fork
agent: tokenomics:scout
---
Investigate this and report briefly: $ARGUMENTS
