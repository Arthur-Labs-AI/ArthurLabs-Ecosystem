#!/usr/bin/env bash
# WSL deploy wrapper: runs the inner deploy with output decoupled to a log
# file (so lingering grandchildren can never hold the launcher's pipes),
# then reports a machine-readable exit marker. All shell logic lives here so
# no quoting or $ expansion crosses the wsl.exe command-line boundary.
# $1 = inner script (Linux path), $2 = source tree (Linux path),
# $3 = version, $4 = log file (Linux path).
set -u
INNER="$1"; SRC="$2"; VERSION="$3"; LOG="$4"
rm -f "$LOG"
bash "$INNER" "$SRC" "$VERSION" > "$LOG" 2>&1
code=$?
echo "SENTRY_DEPLOY_EXIT:$code" | tee -a "$LOG"
exit "$code"
