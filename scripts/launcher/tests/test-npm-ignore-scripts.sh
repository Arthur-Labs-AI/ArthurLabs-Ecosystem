#!/usr/bin/env bash
# test-npm-ignore-scripts.sh — managed agent installs survive restrictive
# npm configurations, modeled on npm >= 12 allowScripts behavior:
# `install` links binaries but runs NO install scripts; scripts execute
# only via `rebuild` after `install-scripts approve <name>`. A binary whose
# payload is missing fails `--version`, exactly like the real managed
# packages whose postinstall was skipped.
# Fixture HOME/bin only; no registry, no network, no sudo.
# Run: bash scripts/launcher/tests/test-npm-ignore-scripts.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "NPMIGNORE-FAIL: $1"; exit 1; }
L="$REPO/scripts/launcher/linux"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/fakebin"
cat > "$T/fakebin/npm" <<'NPMFIX'
#!/bin/sh
# Fixture npm with npm>=12 approval semantics (see file header).
if [ "$1" = "init" ]; then echo '{}' > package.json; exit 0; fi
if [ "$1" = "install-scripts" ]; then
  if [ "$2" = "approve" ] && [ -n "${3:-}" ]; then
    printf '%s\n' "$3" >> "$FIXTURE_APPROVALS"
    exit 0
  fi
  echo "unknown install-scripts usage" >&2
  exit 1
fi
if [ "$1" = "rebuild" ]; then
  name="$2"
  case "$name" in
    opencode-ai) bin=opencode ;;
    @anthropic-ai/claude-code) bin=claude ;;
    *) echo "unknown package $name" >&2; exit 1 ;;
  esac
  if grep -qxF "$name" "$FIXTURE_APPROVALS" 2>/dev/null; then
    # Approved: the postinstall payload materializes beside the binary.
    printf 'payload' > "node_modules/.bin/payload-$bin"
    exit 0
  fi
  echo "scripts blocked for $name" >&2
  exit 1
fi
# Plain install: link a payload-gated binary stub, run no scripts.
spec=""
for a in "$@"; do
  case "$a" in
    *@*) spec="$a" ;;
  esac
done
ver="${spec##*@}"
case "$spec" in
  *opencode-ai*) bin=opencode ;;
  *claude-code*) bin=claude ;;
  *) echo "unknown package $spec" >&2; exit 1 ;;
esac
mkdir -p node_modules/.bin
# The stub resolves its payload next to itself: installers and tests may
# invoke it from any working directory.
printf '#!/bin/sh\nd="$(cd "$(dirname "$0")" && pwd)"\nif [ -f "$d/payload-%s" ]; then echo %s\nelse echo "bin broken (payload missing)" >&2; exit 1\nfi\n' "$bin" "$ver" > "node_modules/.bin/$bin"
chmod +x "node_modules/.bin/$bin"
NPMFIX
chmod +x "$T/fakebin/npm"
OLD_PATH="$PATH"
export PATH="$T/fakebin:$OLD_PATH"
export HOME="$T"
export FIXTURE_APPROVALS="$T/approvals"
: > "$FIXTURE_APPROVALS"
# Static: installers keep the legacy --no-ignore-scripts override (old npm
# with ignore-scripts=true) AND the npm>=12 approve+rebuild flow.
for script in install-opencode.sh install-claude.sh; do
  grep -q -- '--no-ignore-scripts' "$L/$script" || fail "$script lost --no-ignore-scripts"
  grep -q 'install-scripts approve' "$L/$script" || fail "$script lost approve"
  grep -q 'npm rebuild' "$L/$script" || fail "$script lost rebuild"
done
# Functional: real installers produce working binaries under the fixture.
OC_PIN="1.18.32"
bash "$L/install-opencode.sh" "$OC_PIN" >/dev/null || fail "opencode install"
OC_BIN="$T/.local/share/sentry/tools/opencode/node_modules/.bin/opencode"
[ -x "$OC_BIN" ] || fail "opencode binary missing"
[ "$("$OC_BIN" --version)" = "$OC_PIN" ] || fail "opencode version"
CC_PIN="2.1.270"
CC_OUT=$(bash "$L/install-claude.sh" "$CC_PIN") || fail "claude install"
CC_BIN="$T/.local/share/sentry/tools/claude-code/node_modules/.bin/claude"
[ -x "$CC_BIN" ] || fail "claude binary missing"
[ "$("$CC_BIN" --version)" = "$CC_PIN" ] || fail "claude version"
case "$CC_OUT" in
  *"MANAGED_CLAUDE=$CC_BIN"*) ;;
  *) fail "MANAGED_CLAUDE line: [$CC_OUT]" ;;
esac
export PATH="$OLD_PATH"
echo NPMIGNORE-OK
