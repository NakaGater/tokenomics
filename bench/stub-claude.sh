#!/usr/bin/env bash
# Stands in for `claude -p` to try scripts/bench.sh without spending anything: answers with a fixed JSON result.
# The cost differs by arm (the plugin flag is only there in the "on" arm) so the medians have something to show.
for a in "$@"; do [ "$a" = "--plugin-dir" ] && cost=0.05; done
printf '{"result":"done","total_cost_usd":%s,"num_turns":3,"duration_ms":1000,"is_error":false}\n' "${cost:-0.10}"
