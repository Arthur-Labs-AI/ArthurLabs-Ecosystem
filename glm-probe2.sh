#!/bin/bash
# GLM probe with correct model id glm-5.3-flash. No credentials printed.
echo "CONFLICT-CHECK: ANTHROPIC_API_KEY is ${ANTHROPIC_API_KEY:+SET (conflict!)}${ANTHROPIC_API_KEY:-unset (good)}"
cd /tmp
ANTHROPIC_AUTH_TOKEN='REDACTED' ANTHROPIC_BASE_URL='https://api.z.ai/api/anthropic' /home/merte/.local/claude-pinned/node_modules/.bin/claude -p --output-format json --model glm-5.3-flash --permission-mode dontAsk --permission-prompts none 'reply with exactly: MODEL-OK' > /tmp/glm-probe2.json 2>/tmp/glm-probe2.err; echo "EXIT=$?"
python3 /mnt/c/Users/merte/Documents/GitHub/Sentry/strip.py /tmp/glm-probe2.json | head -c 1200; echo
cat /tmp/glm-probe2.err | head -c 500; echo
