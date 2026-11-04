#!/usr/bin/env bash
# Report OpenCode candidates. Prints lines: CANDIDATE <path> <version-or-ABSENT>.
set -u
managed="$HOME/.local/share/sentry/tools/opencode/node_modules/.bin/opencode"
for b in "$managed" opencode; do
  if command -v "$b" >/dev/null 2>&1; then
    ver="$("$b" --version 2>&1 | head -1)"
    echo "CANDIDATE $b $ver"
  else
    echo "CANDIDATE $b ABSENT"
  fi
done
