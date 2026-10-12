#!/usr/bin/env bash
# test-update-safety.sh — update refuses dirty/diverged trees with zero
# mutations, and rollback restores the previous runtime. Fixture HOME and
# fixture git repos only; no network, no fetch, no sudo.
# Run: bash scripts/launcher/tests/test-update-safety.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "UPDATESAFETY-FAIL: $1"; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME="$T"
L="$REPO/scripts/launcher/linux"
source "$L/lib/common.sh"
source "$L/lib/deploy.sh"
source "$L/lib/desktop-ctl.sh"
source "$L/commands/update.sh"
export REPO_ROOT="$T/wt"

mk_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email test@example.invalid
  git -C "$dir" config user.name "sentry-test"
  echo base > "$dir/file.txt"
  git -C "$dir" add file.txt
  git -C "$dir" commit -qm base
}
# Dirty tracked worktree: refuse before any fetch, repo untouched.
mk_repo "$T/wt"
echo dirty >> "$T/wt/file.txt"
before=$(git -C "$T/wt" status --porcelain)
out=$(cmd_update 2>&1 || true)
case "$out" in
  *"contains local changes"*) ;;
  *) fail "dirty refusal message: [$out]" ;;
esac
after=$(git -C "$T/wt" status --porcelain)
[ "$before" = "$after" ] || fail "dirty repo mutated"
if git -C "$T/wt" rev-parse --verify refs/heads/other >/dev/null 2>&1; then fail "unexpected branch"; fi
# Non-main branch: refuse with switch guidance, zero mutations.
git -C "$T/wt" checkout -qb feature
git -C "$T/wt" commit -qam clean-feature 2>/dev/null || true
out=$(cmd_update 2>&1 || true)
case "$out" in
  *"git switch main"*) ;;
  *) fail "branch refusal message: [$out]" ;;
esac
[ "$(git -C "$T/wt" rev-parse --abbrev-ref HEAD)" = "feature" ] || fail "branch moved"
# Diverged channel with Desktop running: refuse BEFORE shutdown (Finding A).
# The full channel matrix lives in test-update-channels.sh; this asserts the
# safety ordering (no shutdown, no merge, HEAD intact) in the safety suite.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/seed"
git -C "$T/seed" config user.email test@example.invalid
git -C "$T/seed" config user.name "sentry-test"
git -C "$T/seed" remote add origin "$T/origin.git"
echo base > "$T/seed/file.txt"
git -C "$T/seed" add file.txt
git -C "$T/seed" commit -qm base
git -C "$T/seed" push -q origin main
git -C "$T/seed" checkout -qb dev
git -C "$T/seed" push -q origin dev
git clone -q "$T/origin.git" "$T/wt2"
git -C "$T/wt2" config user.email test@example.invalid
git -C "$T/wt2" config user.name "sentry-test"
git -C "$T/wt2" checkout -q dev
echo local-only > "$T/wt2/local.txt"
git -C "$T/wt2" add local.txt
git -C "$T/wt2" commit -qm local-only
git -C "$T/seed" checkout -q dev
echo upstream >> "$T/seed/file.txt"
git -C "$T/seed" commit -qam upstream
git -C "$T/seed" push -q origin dev
sentry_desktop_running() { return 0; }
sentry_desktop_ensure_stopped() { echo "STOP-ATTEMPTED"; return 0; }
export REPO_ROOT="$T/wt2"
local_tip=$(git -C "$T/wt2" rev-parse HEAD)
out=$(cmd_update 2>&1 || true)
case "$out" in
  *"diverged"*) ;;
  *) fail "diverged-running refusal: [$out]" ;;
esac
case "$out" in
  *"STOP-ATTEMPTED"*) fail "diverged stopped Desktop before refusing" ;;
esac
[ "$(git -C "$T/wt2" rev-parse HEAD)" = "$local_tip" ] || fail "diverged-running moved HEAD"
source "$L/lib/desktop-ctl.sh"  # restore production Desktop probes
export REPO_ROOT="$T/wt"
# Rollback restores the previous runtime target after a bad deploy.
# Needs real symlinks: MSYS git-bash without symlink privilege copies
# instead, so this section runs only where links work (Linux CI, CachyOS).
mkdir -p "$T/probe" && ln -s "$T/probe" "$T/probe-link" 2>/dev/null || true
if [ -L "$T/probe-link" ]; then
  rm -f "$T/probe-link"
  mkdir -p "$T/.local/share/sentry/runtime/A" "$T/.local/share/sentry/runtime/B"
  rm -f "$T/.local/share/sentry/runtime/current"
  ln -s A "$T/.local/share/sentry/runtime/current"
  rm -f "$T/.local/share/sentry/runtime/current"
  ln -s B "$T/.local/share/sentry/runtime/current"
  sentry_rollback_runtime A >/dev/null
  [ "$(readlink "$T/.local/share/sentry/runtime/current")" = "A" ] || fail "rollback did not restore A"
  [ -d "$T/.local/share/sentry/runtime/B" ] || fail "rollback deleted the new version"
  # NONE means no previous runtime existed: current must go away entirely.
  # (An earlier assertion expecting current to survive rollback NONE
  # encoded the obsolete semantics and was removed.)
  # NONE active, B failed verification: current must not remain on B, and
  # the failed version directory is retained for diagnostics.
  rm -f "$T/.local/share/sentry/runtime/current"
  ln -s B "$T/.local/share/sentry/runtime/current"
  sentry_rollback_runtime NONE >/dev/null || fail "rollback NONE-after-failure"
  [ ! -e "$T/.local/share/sentry/runtime/current" ] || fail "NONE left current on failed B"
  [ -d "$T/.local/share/sentry/runtime/B" ] || fail "failed B directory removed"
  # Rollback with current already absent stays safe and idempotent.
  sentry_rollback_runtime NONE >/dev/null || fail "rollback on absent current"
  [ ! -e "$T/.local/share/sentry/runtime/current" ] || fail "rollback created current"
else
  echo "  (rollback asserts skipped: no symlink privilege on this host)"
fi
echo UPDATESAFETY-OK
