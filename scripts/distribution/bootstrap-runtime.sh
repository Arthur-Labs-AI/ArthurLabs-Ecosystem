#!/usr/bin/env bash
# Online Linux-owned bootstrap. No sudo, no Git, no paid requests.
set -euo pipefail
DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-native}"
if [ "$MODE" != native ] && [ "$MODE" != wsl ]; then echo 'Expected native or wsl mode' >&2; exit 1; fi
if [ "$(uname -m)" != x86_64 ]; then echo 'Sentry requires x64 Linux' >&2; exit 1; fi
if [ "$MODE" = native ]; then
  . "$DIST/scripts/launcher/linux/lib/host-gate.sh"
  sentry_require_cachyos
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then echo 'Use a CachyOS graphical session' >&2; exit 1; fi
  command -v pacman >/dev/null || { echo 'CachyOS pacman is required' >&2; exit 1; }
else
  grep -qi microsoft /proc/sys/kernel/osrelease || { echo 'WSL2 Linux runtime required' >&2; exit 1; }
fi
command -v node >/dev/null || { echo 'Install standalone Linux Node >=22, then retry setup' >&2; exit 1; }
node -e 'if(process.platform!=="linux" || process.versions.electron || +process.versions.node.split(".")[0]<22)process.exit(1)' || { echo 'Standalone Linux Node >=22 required' >&2; exit 1; }
node "$DIST/scripts/distribution/verify.mjs" "$DIST"
expected_target=windows-x64
if [ "$MODE" = native ]; then expected_target=cachyos-x64; fi
node -e 'const m=require(process.argv[1]);if(m.targetPlatform!==process.argv[2])process.exit(1)' "$DIST/distribution.json" "$expected_target"
command -v pnpm >/dev/null || { echo 'Install Linux pnpm 9.12.3 (npm install --prefix "$HOME/.local/share/sentry/pnpm" pnpm@9.12.3), add its bin to PATH, retry' >&2; exit 1; }
pin=$(node -p 'require(process.argv[1]).packageManager.split("@")[1]' "$DIST/runtime-source/package.json")
[ "$(pnpm --version)" = "$pin" ] || { echo "Linux pnpm $pin required" >&2; exit 1; }
for tool in systemctl systemd-run bwrap socat; do
  command -v "$tool" >/dev/null || { echo "Missing $tool; install systemd/bubblewrap/socat using apt in Ubuntu WSL or pacman in CachyOS, then retry. No sudo was run." >&2; exit 1; }
done
systemctl --user show-environment >/dev/null || { echo 'systemd user manager unavailable; see INSTALL.md (WSL systemd=true / enable-linger)' >&2; exit 1; }
bwrap --dev-bind / / --proc /proc /usr/bin/true || { echo 'bubblewrap cannot initialize; repair sandbox prerequisites' >&2; exit 1; }
node "$DIST/scripts/distribution/maintenance.mjs"
BASE="$HOME/.local/share/sentry/runtime"
mkdir -p "$BASE"
LOCK="$BASE/.release-maintenance"
mkdir "$LOCK" || { echo 'Another maintenance operation or interrupted lock exists. Inspect before removing .release-maintenance; see INSTALL.md' >&2; exit 1; }
previous="$(readlink "$BASE/current" 2>/dev/null || true)"
activated=0
probe=""
cleanup() {
  result=$?
  if [ "$result" -ne 0 ] && [ "$activated" = 1 ]; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "$LOCK/rollback"
      mv -Tf "$LOCK/rollback" "$BASE/current"
      echo "Runtime rollback restored $previous" >&2
    else
      rm -f "$BASE/current"
      echo 'Removed unverified current (first install)' >&2
    fi
  fi
  if [ -n "$probe" ]; then rm -rf -- "$probe"; fi
  rmdir "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$DIST/scripts/distribution/maintenance.mjs"
identity=$(node -p 'const m=require(process.argv[1]);m.version+"-"+m.sourceCommit.slice(0,12)' "$DIST/build-identity.json")
candidate="$identity-$(node -p 'require("crypto").randomUUID().slice(0,12)')"
logdir="$HOME/.local/share/sentry/logs"
mkdir -p "$logdir"
log="$logdir/release-$candidate.log"
echo "Staging $candidate; Linux build log: $log"
bash "$DIST/apps/runtime/scripts/deploy-inner.sh" "$DIST/runtime-source" "$candidate" "$(command -v pnpm)" stage-only >"$log" 2>&1 || { tail -n 20 "$log"; exit 1; }
probe=$(mktemp -d "${TMPDIR:-/tmp}/sentry-release-probe.XXXXXX")
node "$DIST/scripts/distribution/runtime-check.mjs" "$BASE/$candidate/apps/runtime/dist/host.js" "$DIST/build-identity.json" "$probe/candidate"
node "$DIST/scripts/distribution/maintenance.mjs"
ln -s "$candidate" "$LOCK/current"
mv -Tf "$LOCK/current" "$BASE/current"
activated=1
node "$DIST/scripts/distribution/runtime-check.mjs" "$BASE/current/apps/runtime/dist/host.js" "$DIST/build-identity.json" "$probe/active"
activated=0
echo "Runtime verified and active: $candidate (previous: ${previous:-NONE}). User data unchanged."
echo 'Next: provision pinned provider tools (sentry tools), open Desktop, configure Settings -> Providers, check Environment.'
