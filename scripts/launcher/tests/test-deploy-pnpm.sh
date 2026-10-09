#!/usr/bin/env bash
# test-deploy-pnpm.sh — deploy-inner.sh honors an explicit pnpm executable
# ($3) while the historical 2-arg invocation keeps working (PATH pnpm).
# Fixture mini-repo + recording pnpm stand-ins: no network, no real build.
# The entry check is EXPECTED to fail (no runtime dist in the fixture);
# the assertions target pnpm selection and current/ safety.
# Run: bash scripts/launcher/tests/test-deploy-pnpm.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "DEPLOYPIN-FAIL: $1"; exit 1; }
INNER="$REPO/apps/runtime/scripts/deploy-inner.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME="$T"
mk_repo() {
  local root="$1"
  mkdir -p "$root/apps/demo" "$root/packages/util"
  echo '{"name":"demo"}' > "$root/apps/demo/package.json"
  echo '{"name":"util"}' > "$root/packages/util/package.json"
  echo '{"name":"qa-platform","version":"0.0.0-test"}' > "$root/package.json"
}
mk_recorder() {
  local path="$1" log="$2"
  cat > "$path" <<'RECORDER'
#!/bin/sh
# Recording pnpm stand-in: logs argv, fakes install, never networks.
echo "$@" >> "@LOG@"
case "$1" in
  install) mkdir -p node_modules ;;
esac
exit 0
RECORDER
  sed -i "s|@LOG@|$log|" "$path"
  chmod +x "$path"
}
mk_repo "$T/src"
# Local credentials/data must never reach the staged runtime source tree.
mkdir -p "$T/src/apps/demo/secrets" "$T/src/apps/demo/logs"
for private in .env .env.local credentials.json state.sqlite state.db private.key; do
  echo PRIVATE_FIXTURE > "$T/src/apps/demo/$private"
done
echo PRIVATE_FIXTURE > "$T/src/apps/demo/secrets/token.txt"
echo PRIVATE_FIXTURE > "$T/src/apps/demo/logs/session.log"
echo '//registry.example.invalid/:_authToken=PRIVATE_FIXTURE' > "$T/src/.npmrc"
mkdir -p "$T/recbin" "$T/decbin" "$T/expbin"
mk_recorder "$T/recbin/pnpm" "$T/rec.log"
cat > "$T/decbin/pnpm" <<'DECOY'
#!/bin/sh
# Decoy: must never execute. Logs misuse, then fails.
echo "$@" >> "@LOG@"
exit 3
DECOY
sed -i "s|@LOG@|$T/decoy.log|" "$T/decbin/pnpm"
chmod +x "$T/decbin/pnpm"
mk_recorder "$T/expbin/mypnpm" "$T/exp.log"
OLD_PATH="$PATH"
# Historical 2-arg form uses PATH pnpm.
PATH="$T/recbin:$OLD_PATH"
if bash "$INNER" "$T/src" vtest-2arg >/dev/null 2>&1; then fail "2-arg unexpectedly succeeded"; fi
PATH="$OLD_PATH"
grep -q '^install --frozen-lockfile$' "$T/rec.log" || fail "2-arg missed frozen install"
grep -q '^exec turbo run build' "$T/rec.log" || fail "2-arg missed turbo build"
[ ! -e "$T/.local/share/sentry/runtime/current" ] || fail "2-arg moved current on failure"
if grep -R -q PRIVATE_FIXTURE "$T/.local/share/sentry/runtime/vtest-2arg.tmp"; then
  fail "private local files entered runtime staging"
fi
# Explicit 3rd arg wins even with a decoy pnpm earlier on PATH.
PATH="$T/decbin:$OLD_PATH"
if bash "$INNER" "$T/src" vtest-3arg "$T/expbin/mypnpm" >/dev/null 2>&1; then fail "3-arg unexpectedly succeeded"; fi
PATH="$OLD_PATH"
[ ! -s "$T/decoy.log" ] || fail "decoy pnpm executed"
grep -q '^install --frozen-lockfile$' "$T/exp.log" || fail "3-arg missed frozen install"
grep -q '^exec turbo run build' "$T/exp.log" || fail "3-arg missed turbo build"
[ ! -e "$T/.local/share/sentry/runtime/current" ] || fail "3-arg moved current on failure"
echo DEPLOYPIN-OK
