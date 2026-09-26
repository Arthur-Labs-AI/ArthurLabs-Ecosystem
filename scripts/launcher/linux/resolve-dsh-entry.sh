#!/usr/bin/env bash
# Resolve the pinned DSH runtime entry from the active Sentry runtime.
# Prints ENTRY=<abs path> and ENTRY_VERSION=<version>. Never guesses: the
# entry must exist under runtime/current and report the expected version.
# $1 = expected version (e.g. 0.1.5-rc.2).
set -u
EXPECTED="$1"
RT=$(readlink -f "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || true)
if [ -z "$RT" ] || [ ! -d "$RT" ]; then echo DSH_ENTRY_MISSING; exit 3; fi
ENTRY=$(find -L "$RT" -path '*@deepseek-ai/dsh/lib/bin.js' 2>/dev/null | head -n 1)
if [ -z "$ENTRY" ]; then echo DSH_ENTRY_MISSING; exit 5; fi
PKG=$(dirname "$(dirname "$ENTRY")")/package.json
VER=$(node -p "require('$PKG').version" 2>/dev/null || true)
echo "ENTRY=$ENTRY"
echo "ENTRY_VERSION=$VER"
if [ "$VER" = "$EXPECTED" ]; then echo ENTRY_OK; else echo ENTRY_DRIFT; fi
