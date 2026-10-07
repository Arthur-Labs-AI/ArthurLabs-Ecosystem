#!/usr/bin/env bash
# test-deepseek-wrapper.sh — the managed DeepSeek wrapper must resolve its
# runtime entry WITHOUT a full tree walk: a `find -L` over the deployed
# tree costs ~20s and blows the runtime's 8s version-probe budget. A
# hostile `find` (fails when called) proves the fast tiers suffice; a
# deep-only layout proves the full-find fallback still works.
# Fixture HOME/runtime only; real node required (as in all agent tests).
# Symlink-dependent cases run only where links work (Linux CI, CachyOS).
# Run: bash scripts/launcher/tests/test-deepseek-wrapper.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "DSHWRAP-FAIL: $1"; exit 1; }
L="$REPO/scripts/launcher/linux"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
EXPECTED="$(sed -n "s/.*DEEPSEEK_SDK_VERSION = '\([^']*\)'.*/\1/p" "$REPO/packages/harness-deepseek/src/sdk.ts" | head -n 1)"
[ -n "$EXPECTED" ] || fail "no expected version"
mkdir -p "$T/fakebin"
cat > "$T/fakebin/find" <<'FINDFIX'
#!/bin/sh
# Hostile find: the fast tiers must never need a tree walk.
echo "find-called: $@" >> "$FIXTURE_FINDLOG"
exit 1
FINDFIX
chmod +x "$T/fakebin/find"
mkbin() {
  local dir="$1"
  mkdir -p "$dir"
  printf '{"name":"@deepseek-ai/dsh","version":"%s"}' "$EXPECTED" > "$dir/package.json"
  printf 'console.log("%s")\n' "$EXPECTED" > "$dir/lib-bin.js"
  mkdir -p "$dir/lib"
  mv "$dir/lib-bin.js" "$dir/lib/bin.js"
}
mkdir -p "$T/probe" && ln -s "$T/probe" "$T/probe-link" 2>/dev/null || true
if [ -L "$T/probe-link" ]; then
  rm -f "$T/probe-link"
  # Case A: pnpm-slice layout resolves via the sdk-client sibling with a
  # hostile find on PATH (any tree walk fails the install).
  mkdir -p "$T/rt/slice/node_modules/@deepseek-ai"
  mkdir -p "$T/rt/packages/harness-deepseek/node_modules/@deepseek-ai"
  mkdir -p "$T/rt/slice/node_modules/@deepseek-ai/dsh-sdk-client"
  mkbin "$T/rt/slice/node_modules/@deepseek-ai/dsh"
  ln -s "$T/rt/slice/node_modules/@deepseek-ai/dsh-sdk-client" "$T/rt/packages/harness-deepseek/node_modules/@deepseek-ai/dsh-sdk-client"
  mkdir -p "$T/home"
  mkdir -p "$T/home/.local/share/sentry/runtime"
  ln -s "$T/rt" "$T/home/.local/share/sentry/runtime/current"
  OLD_PATH="$PATH"
  export PATH="$T/fakebin:$OLD_PATH"
  export HOME="$T/home"
  export FIXTURE_FINDLOG="$T/find.log"
  : > "$FIXTURE_FINDLOG"
  OUT=$(bash "$L/install-deepseek-tool.sh" "$EXPECTED") || fail "install with hostile find"
  case "$OUT" in
    *"MANAGED_DSH=$T/home/.local/share/sentry/tools/deepseek/bin/dsh"*) ;;
    *) fail "managed path: [$OUT]" ;;
  esac
  [ ! -s "$FIXTURE_FINDLOG" ] || fail "tree walk used: [$(cat "$T/find.log")]"
  GOT=$("$T/home/.local/share/sentry/tools/deepseek/bin/dsh" --version) || fail "wrapper run"
  [ "$GOT" = "$EXPECTED" ] || fail "wrapper version: [$GOT]"
  export PATH="$OLD_PATH"
else
  echo "  (sibling cases skipped: no symlink privilege on this host)"
fi
# Case B: deep-only layout falls back to a real find and still resolves.
# (The @deepseek-ai level is required: the find pattern matches it literally.)
mkbin "$T/rt2/a/b/c/@deepseek-ai/dsh"
mkdir -p "$T/home2/.local/share/sentry/runtime"
ln -s "$T/rt2" "$T/home2/.local/share/sentry/runtime/current" 2>/dev/null || true
if [ ! -L "$T/home2/.local/share/sentry/runtime/current" ]; then
  echo "  (fallback case skipped: no symlink privilege on this host)"
  echo DSHWRAP-OK
  exit 0
fi
export HOME="$T/home2"
OUT2=$(bash "$L/install-deepseek-tool.sh" "$EXPECTED") || fail "install with fallback find"
case "$OUT2" in
  *"MANAGED_DSH=$T/home2/.local/share/sentry/tools/deepseek/bin/dsh"*) ;;
  *) fail "fallback managed path: [$OUT2]" ;;
esac
GOT2=$("$T/home2/.local/share/sentry/tools/deepseek/bin/dsh" --version) || fail "fallback wrapper run"
[ "$GOT2" = "$EXPECTED" ] || fail "fallback version: [$GOT2]"
# Case C: nothing anywhere fails closed with the entry-missing signal.
mkdir -p "$T/rt3/empty" "$T/home3/.local/share/sentry/runtime"
ln -s "$T/rt3" "$T/home3/.local/share/sentry/runtime/current" 2>/dev/null || true
if [ ! -L "$T/home3/.local/share/sentry/runtime/current" ]; then
  echo "  (absent case skipped: no symlink privilege on this host)"
  echo DSHWRAP-OK
  exit 0
fi
export HOME="$T/home3"
if bash "$L/install-deepseek-tool.sh" "$EXPECTED" >/dev/null 2>&1; then fail "missing entry accepted"; fi
echo DSHWRAP-OK
