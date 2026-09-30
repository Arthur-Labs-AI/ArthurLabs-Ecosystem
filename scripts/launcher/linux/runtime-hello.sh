#!/usr/bin/env bash
# Handshake probe: send runtime.hello to the deployed entry, print first JSON line.
# $1 = absolute Linux path to host.js. $2 = node executable (default: node).
# The $2 override stays backward compatible: existing callers pass one arg.
set -u
ENTRY="$1"
NODE_BIN="${2:-node}"
if [ ! -f "$ENTRY" ]; then echo ENTRY_MISSING; exit 2; fi
printf '%s\n' '{"type":"request","id":"hs","method":"runtime.hello","params":{}}' | timeout 60 "$NODE_BIN" "$ENTRY" --stdio 2>/dev/null | head -c 4000
echo
