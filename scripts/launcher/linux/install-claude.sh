#!/usr/bin/env bash
# Sentry-managed Claude Code install: local npm prefix only.
# NO sudo, NO global npm modification — the user's global Claude is untouched.
# $1 = version (e.g. 2.1.270).
set -euo pipefail
VERSION="$1"
TOOLS="$HOME/.local/share/sentry/tools/claude-code"
mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || npm init -y >/dev/null 2>&1
npm install "@anthropic-ai/claude-code@${VERSION}" 2>&1 | tail -2
BIN="$TOOLS/node_modules/.bin/claude"
"$BIN" --version
echo "MANAGED_CLAUDE=$BIN"
