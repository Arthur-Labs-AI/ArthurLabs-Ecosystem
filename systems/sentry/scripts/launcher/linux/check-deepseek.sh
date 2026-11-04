#!/usr/bin/env bash
# Report the Sentry-managed DeepSeek tool. $1 = expected version.
# Same probe production preflight performs: <exe> --version must exit 0.
set -u
EXPECTED="$1"
TOOLS="$HOME/.local/share/sentry/tools/deepseek"
BIN="$TOOLS/bin/dsh"
if [ ! -x "$BIN" ]; then echo DSH_MANAGED=missing; exit 0; fi
echo "DSH_MANAGED=$BIN"
VER=$("$BIN" --version 2>&1 | head -n 1)
CODE=$?
echo "DSH_VERSION=$VER"
if [ $CODE -ne 0 ]; then echo DSH_BROKEN; exit 0; fi
if [ "$VER" = "$EXPECTED" ]; then echo "DSH_OK current-runtime"; else echo DSH_DRIFT; fi
