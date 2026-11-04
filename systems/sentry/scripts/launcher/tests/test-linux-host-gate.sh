#!/usr/bin/env bash
# test-linux-host-gate.sh — proves the CachyOS-only support boundary with
# fixture os-release files (no CachyOS host needed, no sudo).
# Run: bash scripts/launcher/tests/test-linux-host-gate.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
GATE="$REPO/scripts/launcher/linux/lib/host-gate.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "HOST-GATE-FAIL: $1"; exit 1; }

printf '%s\n' 'NAME="CachyOS Linux"' 'PRETTY_NAME="CachyOS"' 'ID=cachyos' 'ID_LIKE=arch' > "$T/cachyos"
printf '%s\n' 'NAME="Ubuntu"' 'PRETTY_NAME="Ubuntu 24.04 LTS"' 'ID=ubuntu' 'ID_LIKE=debian' > "$T/ubuntu"
printf '%s\n' 'NAME="Arch Linux"' 'PRETTY_NAME="Arch Linux"' 'ID=arch' > "$T/arch"
: > "$T/empty"

check() {
  desc="$1"; file="$2"; want_id="$3"; want_pretty="$4"
  # shellcheck disable=SC1090
  id=$(SENTRY_OS_RELEASE_PATH="$file" bash -c "source \"$GATE\"; sentry_os_id")
  [ "$id" = "$want_id" ] || fail "$desc id: got [$id] want [$want_id]"
  pretty=$(SENTRY_OS_RELEASE_PATH="$file" bash -c "source \"$GATE\"; sentry_os_pretty")
  [ "$pretty" = "$want_pretty" ] || fail "$desc pretty: got [$pretty] want [$want_pretty]"
}
check cachyos "$T/cachyos" cachyos CachyOS
check ubuntu "$T/ubuntu" ubuntu "Ubuntu 24.04 LTS"
check arch "$T/arch" arch "Arch Linux"
check empty "$T/empty" "" unknown
check missing "$T/no-such-file" "" unknown

SENTRY_OS_RELEASE_PATH="$T/cachyos" bash -c "source \"$GATE\"; sentry_require_cachyos" || fail "cachyos rejected"
if SENTRY_OS_RELEASE_PATH="$T/ubuntu" bash -c "source \"$GATE\"; sentry_require_cachyos" 2>/dev/null; then
  fail "ubuntu accepted"
fi
out=$(SENTRY_OS_RELEASE_PATH="$T/ubuntu" bash -c "source \"$GATE\"; sentry_require_cachyos" 2>&1 || true)
case "$out" in
  *"Native Linux support currently targets CachyOS only."*) ;;
  *) fail "ubuntu message missing support line" ;;
esac
case "$out" in
  *"Detected: Ubuntu 24.04 LTS."*) ;;
  *) fail "ubuntu message missing detected line" ;;
esac
if SENTRY_OS_RELEASE_PATH="$T/arch" bash -c "source \"$GATE\"; sentry_require_cachyos" 2>/dev/null; then
  fail "arch accepted (ID_LIKE must never suffice)"
fi
if SENTRY_OS_RELEASE_PATH="$T/no-such-file" bash -c "source \"$GATE\"; sentry_require_cachyos" 2>/dev/null; then
  fail "missing os-release accepted"
fi
echo HOST-GATE-OK
