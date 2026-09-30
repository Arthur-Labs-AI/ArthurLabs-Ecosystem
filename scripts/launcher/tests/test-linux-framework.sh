#!/usr/bin/env bash
# test-linux-framework.sh — proves the native entrypoint routes help,
# version, and unknown commands without any host gate or CachyOS machine.
# Run: bash scripts/launcher/tests/test-linux-framework.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "FRAMEWORK-FAIL: $1"; exit 1; }

out=$(bash "$REPO/sentry" help) || fail "help exit"
for cmd in setup open update stop cli status doctor version help; do
  printf '%s\n' "$out" | grep -q "^  $cmd " || fail "help missing command: $cmd"
done
case "$out" in
  *"Native Linux support: CachyOS"*) ;;
  *) fail "help missing support boundary" ;;
esac
out=$(bash "$REPO/sentry" version) || fail "version exit"
case "$out" in
  *"Sentry v"*"Commit "*) ;;
  *) fail "version output shape" ;;
esac
if bash "$REPO/sentry" bogus-command >/dev/null 2>&1; then fail "unknown accepted"; fi
out=$(bash "$REPO/sentry" bogus-command 2>&1 || true)
case "$out" in
  *"Unknown command"*"sentry help"*) ;;
  *) fail "unknown hint" ;;
esac
if bash "$REPO/sentry" >/dev/null 2>&1; then :; else fail "bare invocation"; fi
echo FRAMEWORK-OK
