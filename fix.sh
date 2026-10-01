#!/bin/bash
# Runs the fix sequence. Shows progress on screen AND writes run-<timestamp>.log,
# which Claude reads directly - nothing needs copying out of the terminal.
cd "$(dirname "$0")" || exit 1
LOG="run-$(date +%Y-%m-%d-%H-%M-%S).log"
echo "Logging to $LOG"
echo

run() {
  echo "=== $* ===" >>"$LOG"
  printf '\033[1m>> %s\033[0m\n' "$*"
  if node import.js "$@" 2>&1 | tee -a "$LOG"; then :; fi
  local st=${PIPESTATUS[0]}
  echo "exit=$st" >>"$LOG"
  echo >>"$LOG"
  if [ "$st" -ne 0 ]; then
    printf '\033[31m!! step failed (exit %s) - stopping. Tell Claude; the log is %s\033[0m\n' "$st" "$LOG"
    exit "$st"
  fi
  echo
}

run --push-titles --live
run --sync-prices --force --live
run --sync-lengths --force --live
run --sync-variants --only AJNT26,AJLB185 --live
run --sync-skus --live
run --publish --live
run --verify

echo "All steps finished. Log: $LOG"
