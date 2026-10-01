#!/bin/bash
# Dry run of everything fix.sh would do. Changes nothing in the store.
cd "$(dirname "$0")" || exit 1
LOG="check-$(date +%Y-%m-%d-%H-%M-%S).log"
echo "Logging to $LOG"
echo
run() {
  echo "=== $* ===" >>"$LOG"
  printf '\033[1m>> %s\033[0m\n' "$*"
  node import.js "$@" 2>&1 | tee -a "$LOG"
  echo "exit=${PIPESTATUS[0]}" >>"$LOG"
  echo >>"$LOG"
  echo
}
run --push-titles
run --sync-variants --only AJNT26,AJLB185
echo "Done - nothing was changed. Log: $LOG"
