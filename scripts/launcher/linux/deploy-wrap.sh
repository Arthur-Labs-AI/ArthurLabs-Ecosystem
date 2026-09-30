#!/usr/bin/env bash
# WSL deploy wrapper: runs the inner deploy with output decoupled to a log
# file (so lingering grandchildren can never hold the launcher's pipes),
# then reports a machine-readable exit marker. All shell logic lives here so
# no quoting or $ expansion crosses the wsl.exe command-line boundary.
# $1 = inner script (Linux path), $2 = source tree (Linux path),
# $3 = version, $4 = log file (absolute Linux path, already resolved),
# $5 = optional explicit pnpm executable (forwarded as inner $3; callers
# that omit it keep the historical 2-arg inner invocation behavior).
set -u
INNER="$1"; SRC="$2"; VERSION="$3"; LOG="$4"
WRAP_PNPM_BIN="${5:-pnpm}"
case "$LOG" in
  *'$HOME'*) echo "invalid deploy log path (unexpanded HOME): $LOG" >&2; exit 90 ;;
esac
case "$LOG" in
  /*) ;;
  *) echo "invalid deploy log path (not absolute): $LOG" >&2; exit 90 ;;
esac
mkdir -p "$(dirname "$LOG")" || { echo "cannot create deploy log dir" >&2; exit 90; }
rm -f "$LOG"
bash "$INNER" "$SRC" "$VERSION" "$WRAP_PNPM_BIN" > "$LOG" 2>&1
code=$?
echo "SENTRY_DEPLOY_EXIT:$code" | tee -a "$LOG"
exit "$code"
