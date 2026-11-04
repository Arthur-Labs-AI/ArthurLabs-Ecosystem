#!/usr/bin/env bash
# test-electron-repair.sh — a gutted electron/dist is repaired once via a
# scoped rebuild; a present binary triggers no rebuild; an unrepairable
# one fails closed. Fixture repo/pnpm only; no network, no registry.
# Run: bash scripts/launcher/tests/test-electron-repair.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "ELECTRONREPAIR-FAIL: $1"; exit 1; }
L="$REPO/scripts/launcher/linux"
source "$L/lib/common.sh"
source "$L/lib/desktop-ctl.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/fakebin"
cat > "$T/fakebin/pnpm" <<'PNPMFIX'
#!/bin/sh
# Fixture pnpm: only `rebuild electron` is implemented; it materializes
# the binary the real postinstall would have downloaded.
if [ "$1" = "rebuild" ] && [ "$2" = "electron" ]; then
  printf 'rebuild-called\n' >> "$FIXTURE_LOG"
  if [ "$FIXTURE_MODE" = "working" ]; then
    printf '#!/bin/sh\necho electron-fixture\n' > "node_modules/electron/dist/electron"
    chmod +x "node_modules/electron/dist/electron"
    exit 0
  fi
  exit 1
fi
echo "unexpected pnpm call: $@" >&2
exit 1
PNPMFIX
chmod +x "$T/fakebin/pnpm"
mkdesk() {
  local root="$1"
  mkdir -p "$root/apps/desktop/node_modules/electron/dist"
}
OLD_PATH="$PATH"
export PATH="$T/fakebin:$OLD_PATH"
# Case 1: gutted dist is repaired by one scoped rebuild.
mkdesk "$T/r1"
printf 'lib' > "$T/r1/apps/desktop/node_modules/electron/dist/libvulkan.so.1"
export FIXTURE_MODE="working"
export FIXTURE_LOG="$T/r1.log"
export FIXTURE_MODE="working"
sentry_ensure_electron "$T/r1" "$T/fakebin/pnpm" > "$T/o1.txt" || fail "repair failed"
grep -q 'repaired' "$T/o1.txt" || fail "repair marker missing"
[ -x "$T/r1/apps/desktop/node_modules/electron/dist/electron" ] || fail "binary still missing"
# Case 2: present binary triggers no rebuild.
mkdesk "$T/r2"
printf '#!/bin/sh\n' > "$T/r2/apps/desktop/node_modules/electron/dist/electron"
chmod +x "$T/r2/apps/desktop/node_modules/electron/dist/electron"
export FIXTURE_LOG="$T/r2.log"
: > "$T/r2.log"
sentry_ensure_electron "$T/r2" "$T/fakebin/pnpm" > "$T/o2.txt" || fail "present binary rejected"
[ ! -s "$T/r2.log" ] || fail "rebuild ran unnecessarily"
# Case 3: unrepairable binary fails closed with remediation.
mkdesk "$T/r3"
export FIXTURE_MODE="broken"
export FIXTURE_LOG="$T/r3.log"
export FIXTURE_MODE="broken"
if sentry_ensure_electron "$T/r3" "$T/fakebin/pnpm" > "$T/o3.txt" 2>&1; then fail "unrepairable accepted"; fi
grep -q 'still missing' "$T/o3.txt" || fail "remediation missing"
export PATH="$OLD_PATH"
echo ELECTRONREPAIR-OK
