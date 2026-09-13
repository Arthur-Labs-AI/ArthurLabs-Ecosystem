#!/bin/bash
# Report credential PRESENCE only (names + set/unset + length). Never values.
for v in DEEPSEEK_API_KEY DEEPSEEK_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL SENTRY_DEEPSEEK_MODEL SENTRY_GLM_MODEL SENTRY_MUSE_MODEL SENTRY_DEEPSEEK_BINARY SENTRY_CLAUDE_BINARY SENTRY_LIVE_MUSE_TEST; do
  if [ -z "${!v+x}" ]; then echo "$v: unset";
  else echo "$v: set(len=${#1})" | sed "s/len=[0-9]*/len=N/";
  fi
done
echo "--- z.ai docs ---"
ls ~/.config 2>&1 | head -5
