#!/usr/bin/env bash
# test-pnpm-resolve.sh — pinned pnpm resolves to an explicit absolute
# executable in every provisioning path; PATH-export loss cannot break
# setup because callers invoke the emitted path, never ambient pnpm.
# Fixture bin dirs shadow the system in order; nothing touches the
# network, corepack downloads, or global installs.
# Run: bash scripts/launcher/tests/test-pnpm-resolve.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "PNPMRESOLVE-FAIL: $1"; exit 1; }
L="$REPO/scripts/launcher/linux"
source "$L/lib/common.sh"
source "$L/lib/pnpm.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PIN=$(sentry_pinned_pnpm "$REPO")
[ -n "$PIN" ] || fail "no pin"
OLD_PATH="$PATH"
mkfake() {
  local dir="$1" name="$2" body="$3"
  mkdir -p "$dir"
  printf '#!/bin/sh\n%s\n' "$body" > "$dir/$name"
  chmod +x "$dir/$name"
}
# Exact pnpm on PATH: reused verbatim as an absolute path.
mkfake "$T/exactbin" pnpm "echo $PIN"
PATH="$T/exactbin:$OLD_PATH"
out=$(sentry_ensure_pnpm "$REPO") || fail "exact reuse failed"
PATH="$OLD_PATH"
resolved=$(printf '%s\n' "$out" | sed -n 's/^PNPM_RESOLVED=//p' | head -n 1)
case "$resolved" in
  "$T/exactbin/pnpm") ;;
  *) fail "exact reuse path: [$resolved]" ;;
esac
# Wrong pnpm + corepack success: the pinned executable is used.
mkfake "$T/corebin" pnpm "echo 8.0.0"
cat > "$T/corebin/corepack" <<COREPACK
#!/bin/sh
# Fixture corepack: activates the pinned pnpm by writing it here.
HERE_BIN=\$(cd "\$(dirname "\$0")" && pwd)
if [ "\$1" = "prepare" ]; then
  printf '#!/bin/sh\\necho $PIN\\n' > "\$HERE_BIN/pnpm"
  chmod +x "\$HERE_BIN/pnpm"
  exit 0
fi
exit 1
COREPACK
chmod +x "$T/corebin/corepack"
PATH="$T/corebin:$OLD_PATH"
out=$(sentry_ensure_pnpm "$REPO") || fail "corepack path failed"
PATH="$OLD_PATH"
resolved=$(printf '%s\n' "$out" | sed -n 's/^PNPM_RESOLVED=//p' | head -n 1)
case "$resolved" in
  "$T/corebin/pnpm") ;;
  *) fail "corepack resolved path: [$resolved]" ;;
esac
case "$out" in
  *"$PIN (corepack)"*) ;;
  *) fail "corepack marker missing" ;;
esac
# Broken pnpm + failing corepack + fixture npm: user prefix fallback.
mkfake "$T/npmbin" pnpm "echo 8.0.0"
printf '#!/bin/sh\nexit 1\n' > "$T/npmbin/corepack"
chmod +x "$T/npmbin/corepack"
cat > "$T/npmbin/npm" <<NPMFIX
#!/bin/sh
# Fixture npm: emulates npm install --prefix <p> pnpm@<v> offline.
prefix=""
pkg=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --prefix) prefix="\$2"; shift 2 ;;
    *) pkg="\$1"; shift ;;
  esac
done
ver=\$(printf '%s' "\$pkg" | sed 's/^pnpm@//')
mkdir -p "\$prefix/bin"
printf '#!/bin/sh\\necho %s\\n' "\$ver" > "\$prefix/bin/pnpm"
chmod +x "\$prefix/bin/pnpm"
NPMFIX
chmod +x "$T/npmbin/npm"
mkdir -p "$T/fakehome"
OLD_HOME="$HOME"
HOME="$T/fakehome"
PATH="$T/npmbin:$OLD_PATH"
out=$(sentry_ensure_pnpm "$REPO") || fail "npm fallback failed"
PATH="$OLD_PATH"
HOME="$OLD_HOME"
resolved=$(printf '%s\n' "$out" | sed -n 's/^PNPM_RESOLVED=//p' | head -n 1)
case "$resolved" in
  "$T/fakehome/.local/share/sentry/tools/pnpm/bin/pnpm") ;;
  *) fail "prefix resolved path: [$resolved]" ;;
esac
[ -x "$resolved" ] || fail "prefix binary not executable"
# The regression shape: captured inside a subshell (as setup does), the
# emitted path still works — no ambient PATH dependence.
captured=$(PATH="$T/exactbin:$OLD_PATH" sentry_ensure_pnpm "$REPO" | sed -n 's/^PNPM_RESOLVED=//p' | head -n 1)
[ -n "$captured" ] || fail "no captured path"
[ "$("$captured" --version)" = "$PIN" ] || fail "captured path does not run"
# Setup/update must invoke the resolved binary, never bare pnpm.
for f in commands/setup.sh commands/update.sh; do
  if grep -nE '(^|[^_A-Za-z"/-])pnpm (install|build|exec)( |$)' "$REPO/scripts/launcher/linux/$f" | grep -vE '^[0-9]+:[[:space:]]*#'; then
    fail "bare pnpm in $f"
  fi
done
grep -q 'sentry_pnpm_install "$repo" "$pnpm_bin"' "$REPO/scripts/launcher/linux/commands/setup.sh" || fail "setup exact install"
grep -q 'sentry_pnpm_build "$repo" "$pnpm_bin"' "$REPO/scripts/launcher/linux/commands/setup.sh" || fail "setup exact build"
grep -q '"$pnpm_bin" install --frozen-lockfile' "$REPO/scripts/launcher/linux/lib/pnpm.sh" || fail "helper exact install"
grep -q 'sentry_ensure_pnpm "$repo"' "$REPO/scripts/launcher/linux/commands/update.sh" || fail "update re-resolves"
# Grandchild PATH visibility (turbo spawns `pnpm` per task via PATH lookup):
# the fixture mimics turbo — install proceeds only when `pnpm` resolves to
# itself. Helpers must export the binary's directory for their subtree.
mkdir -p "$T/pbindir" "$T/emptyrepo"
cat > "$T/pbindir/pnpm" <<'FIXPNPM'
#!/bin/sh
# Fixture pnpm with turbo-like PATH dependence.
if [ "$1" = "--version" ]; then echo "@PIN@"; exit 0; fi
selfdir="$(cd "$(dirname "$0")" && pwd)"
found="$(command -v pnpm || true)"
if [ "$found" != "$selfdir/pnpm" ]; then echo "PNPM-NOT-ON-PATH"; exit 9; fi
exit 0
FIXPNPM
sed -i "s/@PIN@/$PIN/" "$T/pbindir/pnpm"
chmod +x "$T/pbindir/pnpm"
sentry_pnpm_install "$T/emptyrepo" "$T/pbindir/pnpm" >/dev/null || fail "grandchild PATH export"
sentry_pnpm_build "$T/emptyrepo" "$T/pbindir/pnpm" >/dev/null || fail "grandchild PATH export (build)"
echo PNPMRESOLVE-OK
