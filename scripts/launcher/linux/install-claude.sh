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
# --no-ignore-scripts: see install-opencode.sh — the managed binary needs its
# install scripts, and this prefix is Sentry-owned.
npm install --no-ignore-scripts "@anthropic-ai/claude-code@${VERSION}" 2>&1 | tail -2
# npm >= 12 script approval (allowScripts); see install-opencode.sh.
if npm install-scripts approve "@anthropic-ai/claude-code" >/dev/null 2>&1; then
  npm rebuild "@anthropic-ai/claude-code" 2>&1 | tail -2
fi
BIN="$TOOLS/node_modules/.bin/claude"
"$BIN" --version
echo "MANAGED_CLAUDE=$BIN"
