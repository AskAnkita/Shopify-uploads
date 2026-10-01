#!/bin/bash
# Repricing every product from price-list.csv (retail), then re-applying length surcharges.
cd "$(dirname "$0")" || exit 1
LOG="reprice-$(date +%Y-%m-%d-%H-%M-%S).log"
echo "Logging to $LOG"; echo
run() {
  echo "=== $* ===" >>"$LOG"
  printf '\033[1m>> %s\033[0m\n' "$*"
  node import.js "$@" 2>&1 | tee -a "$LOG"
  local st=${PIPESTATUS[0]}
  echo "exit=$st" >>"$LOG"; echo >>"$LOG"
  if [ "$st" -ne 0 ]; then
    printf '\033[31m!! failed (exit %s) - stopping. Log: %s\033[0m\n' "$st" "$LOG"; exit "$st"
  fi
  echo
}
run --sync-prices --force --live
run --sync-lengths --force --live
run --verify
echo "Done. Log: $LOG"
