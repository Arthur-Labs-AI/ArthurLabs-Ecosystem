#!/usr/bin/env bash
# test-dsh-switch.sh — proves the Sentry-managed dsh wrapper follows
# runtime/current across an A -> B switch without any reinstall.
# Self-contained: fake HOME, fake runtimes, stub dsh entries, real repo scripts.
# Run: bash scripts/launcher/tests/test-dsh-switch.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
INSTALL="$REPO/scripts/launcher/linux/install-deepseek-tool.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME="$T"
RTBASE="$T/.local/share/sentry/runtime"
mk_tree() {
  name="$1"; ver="$2"
  d="$RTBASE/$name/node_modules/@deepseek-ai/dsh"
  mkdir -p "$d/lib"
  printf '{"name":"@deepseek-ai/dsh","version":"%s"}' "$ver" > "$d/package.json"
  cat > "$d/lib/bin.js" <<STUB
#!/usr/bin/env node
const v = "$ver";
if (process.argv.includes('--version')) { console.log(v); process.exit(0); }
console.log('stub-exec:' + v + ':' + process.argv.slice(2).join(','));
STUB
  chmod +x "$d/lib/bin.js"
}
mk_tree A 9.9.9-a
mk_tree B 9.9.9-b
ln -sfn A "$RTBASE/current"
fail() { echo "SWITCH-FAIL: $1"; exit 1; }
[ "$(readlink "$RTBASE/current")" = A ] || fail "fixture current"
bash "$INSTALL" 9.9.9-a >/dev/null || fail "install on A"
BIN="$T/.local/share/sentry/tools/deepseek/bin/dsh"
[ -x "$BIN" ] || fail "wrapper missing"
[ ! -e "$T/.local/share/sentry/tools/deepseek/entry" ] || fail "stale entry symlink retained"
[ "$("$BIN" --version)" = 9.9.9-a ] || fail "version on A"
[ "$("$BIN" --probe-argv 1 2)" = 'stub-exec:9.9.9-a:--probe-argv,1,2' ] || fail "argv passthrough on A"
ln -sfn B "$RTBASE/current"
[ "$("$BIN" --version)" = 9.9.9-b ] || fail "wrapper did not follow current to B"
[ "$("$BIN" --probe-argv 3)" = 'stub-exec:9.9.9-b:--probe-argv,3' ] || fail "argv passthrough on B"
echo SWITCH-OK
