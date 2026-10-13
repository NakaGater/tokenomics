#!/usr/bin/env bash
[ "$(bash sum.sh 1 2 3)" = "6" ] || { echo "FAIL: sum.sh 1 2 3 should print 6"; exit 1; }
[ "$(bash sum.sh)" = "0" ] || { echo "FAIL: sum.sh with nothing should print 0"; exit 1; }
echo "ok"
