#!/usr/bin/env bash
# Report Claude Code candidates: Sentry-managed first, then PATH.
# $1 = expected version (e.g. 2.1.270).
set -u
EXPECTED="$1"
MANAGED="$HOME/.local/share/sentry/tools/claude-code/node_modules/.bin/claude"
if [ -x "$MANAGED" ]; then
  echo "MANAGED=$MANAGED"
  MV=$("$MANAGED" --version 2>&1 | head -n 1)
  echo "MANAGED_VERSION=$MV"
  case "$MANAGED" in /mnt/c*) echo MANAGED_NATIVE=windows-mount;; *) echo MANAGED_NATIVE=linux;; esac
  if [ "$MV" = "$EXPECTED" ]; then echo MANAGED_OK; else echo MANAGED_DRIFT; fi
else
  echo MANAGED=missing
fi
P=$(command -v claude 2>/dev/null || echo MISSING)
echo "PATH_CLAUDE=$P"
case "$P" in
  /mnt/c*) echo PATH_NATIVE=windows-mount ;;
  MISSING) echo PATH_NATIVE=missing ;;
  *) echo PATH_NATIVE=linux ;;
esac
if [ "$P" != MISSING ]; then
  PV=$(claude --version 2>&1 | head -n 1)
  echo "PATH_VERSION=$PV"
  if [ "$PV" = "$EXPECTED" ]; then echo PATH_OK; else echo PATH_DRIFT; fi
fi
