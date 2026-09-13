#!/bin/bash
# Full model list from Z.AI (key stays in the user's shell env).
if [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
  echo "ANTHROPIC_AUTH_TOKEN is unset in this shell - export it first"
  exit 1
fi
curl -s -w '\nHTTP:%{http_code}\n' https://api.z.ai/api/paas/v4/models -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -o /tmp/zai-models.json
cat /tmp/zai-models.json | head -c 3000; echo
