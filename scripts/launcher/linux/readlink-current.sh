#!/usr/bin/env bash
# Print the active runtime version (readlink current) or NONE.
set -u
if [ -L "$HOME/.local/share/sentry/runtime/current" ]; then
  readlink "$HOME/.local/share/sentry/runtime/current"
else
  echo NONE
fi
