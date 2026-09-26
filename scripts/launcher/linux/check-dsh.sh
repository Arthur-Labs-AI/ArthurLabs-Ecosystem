#!/usr/bin/env bash
# Report optional dsh CLI presence (DeepSeek runs primarily via the bundled SDK).
set -u
if command -v dsh >/dev/null 2>&1; then
  echo "PATH=$(command -v dsh)"
  dsh --version 2>&1 | head -1
else
  echo DSH_ABSENT
fi
