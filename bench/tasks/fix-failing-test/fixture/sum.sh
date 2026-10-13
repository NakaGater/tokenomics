#!/usr/bin/env bash
# Prints the sum of the numbers it is given.
total=0
for n in "$@"; do total=$((total - n)); done
echo "$total"
