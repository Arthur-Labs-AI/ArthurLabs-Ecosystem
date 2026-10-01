#!/usr/bin/env bash
# test-npm-ignore-scripts.sh — managed agent installs must survive a user
# npm config with ignore-scripts=true. The fixture npm models that config:
# package installs WITHOUT --no-ignore-scripts create nothing (silent
# skip, like real npm); WITH the flag they materialize the binary.
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
# Fixture npm with global ignore-scripts semantics.
if [ "$1" = "init" ]; then echo '{}' > package.json; exit 0; fi
allow=""
spec=""
for a in "$@"; do
  case "$a" in
    --no-ignore-scripts) allow=1 ;;
    *@*) spec="$a" ;;
  esac
done
if [ -z "$allow" ]; then echo "skipped scripts for $spec"; exit 0; fi
ver="${spec##*@}"
case "$spec" in
  *opencode-ai*) name=opencode ;;
  *claude-code*) name=claude ;;
  *) echo "unknown package $spec"; exit 1 ;;
esac
mkdir -p node_modules/.bin
printf '#!/bin/sh\necho %s\n' "$ver" > "node_modules/.bin/$name"
chmod +x "node_modules/.bin/$name"
NPMFIX
chmod +x "$T/fakebin/npm"
OLD_PATH="$PATH"
export PATH="$T/fakebin:$OLD_PATH"
export HOME="$T"
# Negative control: without the flag the fixture (like real npm with
# ignore-scripts=true) creates nothing — this is the bug being modeled.
mkdir -p "$T/neg"
(cd "$T/neg" && npm install "opencode-ai@9.9.9" >/dev/null 2>&1)
[ ! -e "$T/neg/node_modules/.bin/opencode" ] || fail "fixture does not model the skip"
# Real installers defeat the strict config via --no-ignore-scripts.
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
