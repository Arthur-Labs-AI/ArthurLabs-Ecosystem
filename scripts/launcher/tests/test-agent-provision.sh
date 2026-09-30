#!/usr/bin/env bash
# test-agent-provision.sh — fresh managed Claude install is validated and
# persisted (SENTRY_GLM_BINARY); persistence failure blocks GLM readiness.
# Fixture HOME/npm only: no registry, no network, no Electron. Persist is
# mocked at the control boundary (its real path needs a display server).
# Run: bash scripts/launcher/tests/test-agent-provision.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "AGENTPROV-FAIL: $1"; exit 1; }
L="$REPO/scripts/launcher/linux"
source "$L/lib/common.sh"
source "$L/lib/desktop-ctl.sh"
source "$L/lib/agents.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PIN_CC=$(node -e 'import(process.argv[1]).then((m) => console.log(m.PINNED_CLAUDE_CODE_VERSION))' -- "$(sentry_file_url "$REPO/scripts/launcher/launcher-logic.mjs")")
[ -n "$PIN_CC" ] || fail "no claude pin"
# Fixture npm: materializes node_modules/.bin/claude printing the version.
mkdir -p "$T/fakebin" "$T/tools/claude-code"
printf '{"name":"x"}' > "$T/tools/claude-code/package.json"
cat > "$T/fakebin/npm" <<'NPMFIX'
#!/bin/sh
spec=""
for a in "$@"; do
  case "$a" in
    *@*) spec="$a" ;;
  esac
done
ver="${spec##*@}"
mkdir -p node_modules/.bin
printf '#!/bin/sh\necho %s\n' "$ver" > node_modules/.bin/claude
chmod +x node_modules/.bin/claude
NPMFIX
chmod +x "$T/fakebin/npm"
# Seeds shared by both cases: OpenCode ready, DeepSeek ready.
seed_common() {
  local home="$1"
  local oc="$home/.local/share/sentry/tools/opencode/node_modules/.bin"
  mkdir -p "$oc"
  printf '#!/bin/sh\necho opencode version 1.18.32\n' > "$oc/opencode"
  chmod +x "$oc/opencode"
  local expected="$(sed -n "s/.*DEEPSEEK_SDK_VERSION = '\([^']*\)'.*/\1/p" "$REPO/packages/harness-deepseek/src/sdk.ts" | head -n 1)"
  local dsd="$home/.local/share/sentry/runtime/current/node_modules/@deepseek-ai/dsh"
  mkdir -p "$dsd/lib"
  printf '{"name":"@deepseek-ai/dsh","version":"%s"}' "$expected" > "$dsd/package.json"
  printf '#!/usr/bin/env node\nconsole.log("%s")\n' "$expected" > "$dsd/lib/bin.js"
  chmod +x "$dsd/lib/bin.js"
}
OLD_PATH="$PATH"
export PATH="$T/fakebin:$OLD_PATH"
# Case 1: persist succeeds -> managed path recorded, GLM ready.
seed_common "$T/home1"
export HOME="$T/home1"
mkdir -p "$HOME"
> "$T/persist1.log"
sentry_desktop_persist_binary() { printf '%s=%s\n' "$2" "$3" >> "$T/persist1.log"; return 0; }
sentry_provision_agents "$REPO" > "$T/out1.txt" || fail "provision failed"
grep -q '^AGENTS_CLAUDE=1$' "$T/out1.txt" || fail "fresh claude not ready"
grep -q "^SENTRY_GLM_BINARY=$T/home1/.local/share/sentry/tools/claude-code/node_modules/.bin/claude$" "$T/persist1.log" || fail "persisted value"
# Case 2: persist fails -> installed but GLM NOT falsely ready.
seed_common "$T/home2"
export HOME="$T/home2"
mkdir -p "$HOME"
sentry_desktop_persist_binary() { return 1; }
sentry_provision_agents "$REPO" > "$T/out2.txt" || fail "provision failed"
grep -q '^AGENTS_CLAUDE=0$' "$T/out2.txt" || fail "persist failure still ready"
grep -q 'SENTRY_GLM_BINARY was not persisted' "$T/out2.txt" || fail "persist warn missing"
# Case 3: managed already installed (MANAGED_OK) + persist fails -> not ready.
# (Second setup after case-2-like state must not flip to ready silently.)
seed_common "$T/home3"
export HOME="$T/home3"
mkdir -p "$HOME"
MGD="$T/home3/.local/share/sentry/tools/claude-code/node_modules/.bin"
mkdir -p "$MGD"
printf '#!/bin/sh\necho %s\n' "$PIN_CC" > "$MGD/claude"
chmod +x "$MGD/claude"
sentry_desktop_persist_binary() { return 1; }
sentry_provision_agents "$REPO" > "$T/out3.txt" || fail "provision failed"
grep -q '^AGENTS_CLAUDE=0$' "$T/out3.txt" || fail "managed persist failure still ready"
grep -q 'could not be persisted' "$T/out3.txt" || fail "managed persist warn missing"
# Case 4: PATH-native Claude + persist fails -> still ready via PATH, warned.
mkdir -p "$T/pathbin"
printf '#!/bin/sh\necho %s\n' "$PIN_CC" > "$T/pathbin/claude"
chmod +x "$T/pathbin/claude"
seed_common "$T/home4"
export HOME="$T/home4"
mkdir -p "$HOME" 
export PATH="$T/pathbin:$T/fakebin:$OLD_PATH"
sentry_desktop_persist_binary() { return 1; }
sentry_provision_agents "$REPO" > "$T/out4.txt" || fail "provision failed"
grep -q '^AGENTS_CLAUDE=1$' "$T/out4.txt" || fail "PATH claude not ready"
grep -q 'from PATH' "$T/out4.txt" || fail "PATH warn missing"
export PATH="$OLD_PATH"
echo AGENTPROV-OK
