---
name: scout
description: Hand a read-only code investigation to a cheap agent that returns a short report with file paths, so the files read stay out of your context. Use when finding where something is defined or used, or how a part of the code works, would take several searches or file reads. Don't use it for one known file or a single quick grep, or for code you are about to edit. Pass the question as the argument.
argument-hint: "[調べたいこと]"
context: fork
agent: tokenomics:scout
---
Investigate this and report briefly: $ARGUMENTS
