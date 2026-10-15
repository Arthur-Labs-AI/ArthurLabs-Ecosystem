#!/usr/bin/env bash
# test-update-channels.sh -- source update tracks the explicitly selected channel:
# branch dev fetches/merges origin/dev, branch main fetches/merges origin/main,
# every other checkout refuses with zero Git mutations.
# Uses disposable local git repos (a file-path origin remote, no network) and
# asserts the ACTUAL merged HEAD SHA, not merely the printed message.
# Run: bash scripts/launcher/tests/test-update-channels.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "UPDATECHANNELS-FAIL: $1"; exit 1; }
pass() { echo "UPDATECHANNELS-PASS: $1"; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME="$T"
L="$REPO/scripts/launcher/linux"
source "$L/lib/common.sh"
source "$L/lib/desktop-ctl.sh"
source "$L/lib/config.sh"
source "$L/lib/node.sh"
source "$L/commands/update.sh"

git_env() { git -c user.email=test@example.invalid -c user.name=sentry-test "$@"; }

# --- unit: channel allowlist mapping (the exact ref cmd_update fetches/merges) ---
[ "$(sentry_update_remote_ref dev)" = "origin/dev" ] || fail "map dev"
[ "$(sentry_update_remote_ref main)" = "origin/main" ] || fail "map main"
[ -z "$(sentry_update_remote_ref feature/example)" ] || fail "map feature must be empty"
[ -z "$(sentry_update_remote_ref fix/example)" ] || fail "map fix must be empty"
[ -z "$(sentry_update_remote_ref release/v1.0.0-rc.1)" ] || fail "map release must be empty"
[ -z "$(sentry_update_remote_ref hotfix/v1.0.0-x)" ] || fail "map hotfix must be empty"
[ -z "$(sentry_update_remote_ref HEAD)" ] || fail "map detached HEAD must be empty"
pass "channel allowlist mapping"

# --- fixture origin with divergent dev/main tips ---
git_env init -q --bare "$T/origin.git"
git_env init -q -b main "$T/seed"
git_env -C "$T/seed" remote add origin "$T/origin.git"
echo base > "$T/seed/file.txt"
git_env -C "$T/seed" add file.txt
git_env -C "$T/seed" commit -qm base
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$T/seed/sentry"
chmod +x "$T/seed/sentry"
git_env -C "$T/seed" add sentry
git_env -C "$T/seed" commit -qm stub-sentry-handoff
git_env -C "$T/seed" push -q origin main
git_env -C "$T/seed" checkout -qb dev
echo dev1 > "$T/seed/dev.txt"
git_env -C "$T/seed" add dev.txt
git_env -C "$T/seed" commit -qm dev1
git_env -C "$T/seed" push -q origin dev
git_env clone -q "$T/origin.git" "$T/wt"
export REPO_ROOT="$T/wt"
DEV_TIP=$(git_env -C "$T/wt" rev-parse origin/dev)
MAIN_TIP=$(git_env -C "$T/wt" rev-parse origin/main)
[ "$DEV_TIP" != "$MAIN_TIP" ] || fail "fixture needs divergent channel tips"
# --- clean dev, already current: exit 0, channel reported ---
git_env -C "$T/wt" checkout -q dev
out=$(cmd_update 2>&1) || fail "clean dev already-current exit: [$out]"
case "$out" in *"already up to date"*) ;; *) fail "dev already-current message: [$out]" ;; esac
case "$out" in *"source channel: origin/dev"*) ;; *) fail "dev channel report: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$DEV_TIP" ] || fail "dev HEAD moved on no-op"
pass "clean dev already-current"

# --- clean main, already current ---
git_env -C "$T/wt" checkout -q main
out=$(cmd_update 2>&1) || fail "clean main already-current exit: [$out]"
case "$out" in *"source channel: origin/main"*) ;; *) fail "main channel report: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$MAIN_TIP" ] || fail "main HEAD moved on no-op"
pass "clean main already-current"

# --- dev follows origin/dev only: advance ONLY dev upstream ---
# The post-update handoff execs the repo sentry entry; stub it to exit 0 and
# run inside a subshell (exec replaces only the subshell).
git_env -C "$T/seed" checkout -q dev
echo dev2 >> "$T/seed/dev.txt"
git_env -C "$T/seed" commit -qam dev2
git_env -C "$T/seed" push -q origin dev
NEW_DEV_TIP=$(git_env -C "$T/seed" rev-parse HEAD)
git_env -C "$T/wt" checkout -q dev
upd_out=$(cmd_update 2>&1) || fail "dev advance update exit: [$upd_out]"
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$NEW_DEV_TIP" ] || fail "dev did not fast-forward to origin/dev"
[ "$(git_env -C "$T/wt" rev-parse HEAD)" != "$MAIN_TIP" ] || fail "dev followed origin/main"
pass "dev fast-forwards to origin/dev only"

# --- main follows origin/main only: advance ONLY main upstream ---
git_env -C "$T/seed" checkout -q main
echo main2 >> "$T/seed/file.txt"
git_env -C "$T/seed" commit -qam main2
git_env -C "$T/seed" push -q origin main
NEW_MAIN_TIP=$(git_env -C "$T/seed" rev-parse HEAD)
git_env -C "$T/wt" checkout -q main
upd_out=$(cmd_update 2>&1) || fail "main advance update exit: [$upd_out]"
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$NEW_MAIN_TIP" ] || fail "main did not fast-forward to origin/main"
pass "main fast-forwards to origin/main only"
# --- Finding A: diverged channel with Desktop running must refuse BEFORE shutdown ---
sentry_desktop_running() { return 0; }
sentry_desktop_ensure_stopped() { echo "STOP-ATTEMPTED"; return 0; }
git_env -C "$T/wt" checkout -q dev
echo local-dev > "$T/wt/local-dev.txt"
git_env -C "$T/wt" add local-dev.txt
git_env -C "$T/wt" commit -qm local-dev
git_env -C "$T/seed" checkout -q dev
echo dev4 >> "$T/seed/dev.txt"
git_env -C "$T/seed" commit -qam dev4
git_env -C "$T/seed" push -q origin dev
local_dev_tip=$(git_env -C "$T/wt" rev-parse HEAD)
out=$(cmd_update 2>&1 || true)
case "$out" in *"diverged"*) ;; *) fail "diverged-running refusal: [$out]" ;; esac
case "$out" in *"STOP-ATTEMPTED"*) fail "diverged stopped Desktop before refusing" ;; esac
case "$out" in *"git merge --ff-only"*) fail "diverged attempted merge" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$local_dev_tip" ] || fail "diverged-running moved HEAD"
[ -f "$T/wt/local-dev.txt" ] || fail "diverged-running lost local commit"
pass "diverged dev refuses before shutdown"
git_env -C "$T/wt" checkout -q main
echo local-main > "$T/wt/local-main.txt"
git_env -C "$T/wt" add local-main.txt
git_env -C "$T/wt" commit -qm local-main
git_env -C "$T/seed" checkout -q main
echo main3 >> "$T/seed/file.txt"
git_env -C "$T/seed" commit -qam main3
git_env -C "$T/seed" push -q origin main
local_main_tip=$(git_env -C "$T/wt" rev-parse HEAD)
out=$(cmd_update 2>&1 || true)
case "$out" in *"diverged"*) ;; *) fail "diverged-main refusal: [$out]" ;; esac
case "$out" in *"STOP-ATTEMPTED"*) fail "diverged main stopped Desktop before refusing" ;; esac
case "$out" in *"git merge --ff-only"*) fail "diverged main attempted merge" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$local_main_tip" ] || fail "diverged-main moved HEAD"
pass "diverged main refuses before shutdown"
# --- eligible behind-dev with Desktop running still proceeds (stop, merge, advance) ---
git_env -C "$T/wt" checkout -q dev
git_env -C "$T/wt" reset -q --hard "$NEW_DEV_TIP"
dev4_tip=$(git_env -C "$T/seed" rev-parse dev)
( cmd_update >"$T/upd-dev.log" 2>&1 ) || fail "eligible-running update exit"
upd_out=$(cat "$T/upd-dev.log")
case "$upd_out" in *"STOP-ATTEMPTED"*) ;; *) fail "eligible update skipped shutdown: [$upd_out]" ;; esac
case "$upd_out" in *"git merge --ff-only origin/dev"*) ;; *) fail "eligible update skipped merge: [$upd_out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$dev4_tip" ] || fail "eligible update did not advance"
pass "behind dev proceeds after eligible preflight"
# --- locally ahead: refuse with guidance, no shutdown, no rewrite ---
echo ahead-only > "$T/wt/ahead.txt"
git_env -C "$T/wt" add ahead.txt
git_env -C "$T/wt" commit -qm ahead-only
ahead_tip=$(git_env -C "$T/wt" rev-parse HEAD)
out=$(cmd_update 2>&1 || true)
case "$out" in *"ahead"*) ;; *) fail "ahead refusal: [$out]" ;; esac
case "$out" in *"STOP-ATTEMPTED"*) fail "ahead stopped Desktop" ;; esac
case "$out" in *"git merge --ff-only"*) fail "ahead attempted merge" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$ahead_tip" ] || fail "ahead moved HEAD"
pass "ahead dev refuses without rewrite"
# --- ancestry-check failure wiring refuses safely (forced preflight word) ---
sentry_ff_eligibility() { printf '%s' "preflight-failed"; }
out=$(cmd_update 2>&1 || true)
case "$out" in *"Could not verify"*) ;; *) fail "preflight-failure refusal: [$out]" ;; esac
case "$out" in *"STOP-ATTEMPTED"*) fail "preflight failure stopped Desktop" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$ahead_tip" ] || fail "preflight failure moved HEAD"
pass "preflight failure refuses safely"
source "$L/commands/update.sh"  # restore the production eligibility helper
# --- eligibility helper mapping on a scratch clone (real git ancestry) ---
git_env clone -q "$T/origin.git" "$T/probe"
git_env -C "$T/probe" checkout -q dev
[ "$(sentry_ff_eligibility "$T/probe" "origin/dev")" = "eligible" ] || fail "helper eligible"
git_env -C "$T/probe" update-ref -d refs/remotes/origin/dev
[ "$(sentry_ff_eligibility "$T/probe" "origin/dev")" = "preflight-failed" ] || fail "helper missing ref"
[ "$(sentry_ff_eligibility "$T/probe" "origin/does-not-exist")" = "preflight-failed" ] || fail "helper bad ref"
git_env -C "$T/probe" fetch -q origin dev
git_env -C "$T/probe" checkout -q --detach origin/dev
git_env -C "$T/probe" commit -q --allow-empty -m side
side_tip=$(git_env -C "$T/probe" rev-parse HEAD)
git_env -C "$T/probe" checkout -q dev
echo probe-local > "$T/probe/probe-local.txt"
git_env -C "$T/probe" add probe-local.txt
git_env -C "$T/probe" commit -qm probe-local
[ "$(sentry_ff_eligibility "$T/probe" "origin/dev")" = "ahead" ] || fail "helper ahead"
git_env -C "$T/probe" update-ref refs/remotes/origin/dev "$side_tip"
[ "$(sentry_ff_eligibility "$T/probe" "origin/dev")" = "diverged" ] || fail "helper diverged"
pass "eligibility helper mapping"
# --- missing selected remote branch refuses safely ---
git_env init -q --bare "$T/origin2.git"
git_env init -q -b main "$T/seed2"
git_env -C "$T/seed2" remote add origin "$T/origin2.git"
echo base > "$T/seed2/f.txt"
git_env -C "$T/seed2" add f.txt
git_env -C "$T/seed2" commit -qm base
git_env -C "$T/seed2" push -q origin main
git_env clone -q "$T/origin2.git" "$T/wt2"
git_env -C "$T/wt2" checkout -qb dev origin/main
wt2_head=$(git_env -C "$T/wt2" rev-parse HEAD)
REPO_ROOT="$T/wt2"
out=$(cmd_update 2>&1 || true)
case "$out" in *"git fetch failed"*) ;; *) fail "missing-remote refusal: [$out]" ;; esac
case "$out" in *"STOP-ATTEMPTED"*) fail "missing remote stopped Desktop" ;; esac
[ "$(git_env -C "$T/wt2" rev-parse HEAD)" = "$wt2_head" ] || fail "missing remote moved HEAD"
REPO_ROOT="$T/wt"
pass "missing selected remote refuses safely"
# --- dirty main refuses before fetch ---
git_env -C "$T/wt" checkout -q main
git_env -C "$T/wt" reset -q --hard origin/main
echo dirty >> "$T/wt/file.txt"
out=$(cmd_update 2>&1 || true)
case "$out" in *"contains local changes"*) ;; *) fail "dirty-main refusal: [$out]" ;; esac
case "$out" in *"git fetch"*) fail "dirty main fetched before refusing" ;; esac
git_env -C "$T/wt" checkout -q -- file.txt
pass "dirty main refuses before fetch"
# --- behind main with Desktop running proceeds ---
git_env -C "$T/seed" checkout -q main
echo main4 >> "$T/seed/file.txt"
git_env -C "$T/seed" commit -qam main4
git_env -C "$T/seed" push -q origin main
main4_tip=$(git_env -C "$T/seed" rev-parse HEAD)
( cmd_update >"$T/upd-main.log" 2>&1 ) || fail "eligible-main update exit"
upd_out=$(cat "$T/upd-main.log")
case "$upd_out" in *"STOP-ATTEMPTED"*) ;; *) fail "eligible main skipped shutdown: [$upd_out]" ;; esac
case "$upd_out" in *"git merge --ff-only origin/main"*) ;; *) fail "eligible main skipped merge: [$upd_out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$main4_tip" ] || fail "eligible main did not advance"
pass "behind main proceeds after eligible preflight"
source "$L/lib/desktop-ctl.sh"  # restore production Desktop probes
# --- feature branch refuses with zero mutations ---
git_env -C "$T/wt" checkout -qb feature/example
before=$(git_env -C "$T/wt" rev-parse HEAD)
out=$(cmd_update 2>&1 || true)
case "$out" in *"explicitly selected channel"*) ;; *) fail "feature refusal: [$out]" ;; esac
case "$out" in *"git switch dev"*) ;; *) fail "feature guidance names dev: [$out]" ;; esac
case "$out" in *"Zero Git mutations"*) ;; *) fail "feature zero-mutation claim: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse --abbrev-ref HEAD)" = "feature/example" ] || fail "feature branch moved"
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$before" ] || fail "feature HEAD moved"
pass "feature branch refuses"

# --- release branch refuses ---
git_env -C "$T/wt" checkout -qb release/v1.0.0-rc.1
out=$(cmd_update 2>&1 || true)
case "$out" in *"explicitly selected channel"*) ;; *) fail "release refusal: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse --abbrev-ref HEAD)" = "release/v1.0.0-rc.1" ] || fail "release branch moved"
pass "release branch refuses"

# --- detached tag refuses (pinned beta stays pinned) ---
git_env -C "$T/wt" tag v9.9.9-test
git_env -C "$T/wt" checkout -q --detach v9.9.9-test
out=$(cmd_update 2>&1 || true)
case "$out" in *"detached HEAD"*) ;; *) fail "detached refusal: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse --abbrev-ref HEAD)" = "HEAD" ] || fail "detached checkout moved"
pass "detached tag refuses"

# --- dirty dev refuses, HEAD untouched ---
git_env -C "$T/wt" checkout -q dev
dirty_dev_before=$(git_env -C "$T/wt" rev-parse HEAD)
echo dirty >> "$T/wt/file.txt"
out=$(cmd_update 2>&1 || true)
case "$out" in *"contains local changes"*) ;; *) fail "dirty refusal: [$out]" ;; esac
[ -n "$(git_env -C "$T/wt" status --porcelain)" ] || fail "dirty marker vanished"
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$dirty_dev_before" ] || fail "dirty update moved HEAD"
git_env -C "$T/wt" checkout -q -- file.txt
[ -z "$(git_env -C "$T/wt" status --porcelain)" ] || fail "cleanup left dirt"
pass "dirty dev refuses"

# --- diverged dev refuses (fast-forward only, no reset) ---
git_env -C "$T/wt" checkout -q dev
echo local-only > "$T/wt/local.txt"
git_env -C "$T/wt" add local.txt
git_env -C "$T/wt" commit -qm local-only
git_env -C "$T/seed" checkout -q dev
echo dev3 >> "$T/seed/dev.txt"
git_env -C "$T/seed" commit -qam dev3
git_env -C "$T/seed" push -q origin dev
local_tip=$(git_env -C "$T/wt" rev-parse HEAD)
out=$(cmd_update 2>&1 || true)
case "$out" in *"diverged"*) ;; *) fail "diverged refusal: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$local_tip" ] || fail "diverged update reset local work"
git_env -C "$T/wt" reset -q --hard "$NEW_DEV_TIP"
pass "diverged dev refuses"

# --- fetch failure is safe (no merge, HEAD untouched) ---
before=$(git_env -C "$T/wt" rev-parse HEAD)
git_env -C "$T/wt" remote set-url origin "$T/does-not-exist.git"
out=$(cmd_update 2>&1 || true)
case "$out" in *"git fetch failed"*) ;; *) fail "fetch-failure message: [$out]" ;; esac
[ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$before" ] || fail "fetch failure moved HEAD"
pass "fetch failure is safe"
git_env -C "$T/wt" remote set-url origin "$T/origin.git"
git_env -C "$T/wt" fetch -q origin dev

# --- graceful-stop failure blocks deployment (no merge) ---
sentry_desktop_running() { return 0; }
sentry_desktop_ensure_stopped() { echo "stub stop refused"; return 1; }
before=$(git_env -C "$T/wt" rev-parse HEAD)
remote_now=$(git_env -C "$T/wt" rev-parse origin/dev)
if [ "$before" != "$remote_now" ]; then
  out=$(cmd_update 2>&1 || true)
  case "$out" in *"stub stop refused"*) ;; *) fail "stop-failure message: [$out]" ;; esac
  [ "$(git_env -C "$T/wt" rev-parse HEAD)" = "$before" ] || fail "stop failure still merged"
  pass "graceful-stop failure blocks deployment"
else
  pass "graceful-stop already current (stop path not reached)"
fi
unset -f sentry_desktop_running sentry_desktop_ensure_stopped

# --- non-git directory (packaged-style install) refuses ---
mkdir -p "$T/nogit"
REPO_ROOT="$T/nogit"
out=$(cmd_update 2>&1 || true)
case "$out" in *"explicitly selected channel"*) ;; *) fail "non-git refusal: [$out]" ;; esac
pass "non-git checkout refuses"

echo UPDATECHANNELS-OK
