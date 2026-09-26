#!/usr/bin/env bash
# Sentry WSL runtime deploy (inner, runs inside Linux).
# Atomic: sync -> install (frozen) -> build -> validate -> THEN activate.
# A failed build never touches the previous `current` runtime.
set -euo pipefail
SRC="$1"; VERSION="$2"
BASE="$HOME/.local/share/sentry/runtime"
DEST="$BASE/$VERSION"
mkdir -p "$BASE"
echo "[sentry-runtime] syncing tree for $VERSION ..."
rm -rf "$DEST.tmp"; mkdir -p "$DEST.tmp"
cd "$SRC"
for e in * .npmrc .nvmrc pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json eslint.config.js prettier.config.js; do
  [ -e "$e" ] || continue
  case "$e" in node_modules|dist|.git|.turbo) continue;; esac
  cp -r --no-preserve=all "$e" "$DEST.tmp/"
done
mkdir -p "$DEST.tmp/apps" "$DEST.tmp/packages"
for a in apps/*/; do
  n=$(basename "$a")
  mkdir -p "$DEST.tmp/apps/$n"
  (cd "$a" && tar --exclude=node_modules --exclude=dist --exclude=.turbo -cf - .) | tar -xf - -C "$DEST.tmp/apps/$n"
done
for p in packages/*/; do
  n=$(basename "$p")
  mkdir -p "$DEST.tmp/packages/$n"
  (cd "$p" && tar --exclude=node_modules --exclude=dist --exclude=.turbo -cf - .) | tar -xf - -C "$DEST.tmp/packages/$n"
done
echo SYNC_OK
cd "$DEST.tmp"
export CI=true
echo "[sentry-runtime] installing Linux dependencies (frozen lockfile)..."
pnpm install --frozen-lockfile
echo "[sentry-runtime] building runtime packages..."
pnpm --filter @qa/runtime-protocol --filter @qa/runtime --filter @qa/harness-claude-code --filter @qa/harness-deepseek --filter @qa/harness-opencode --filter @qa/evidence-pipeline --filter @qa/merger --filter @qa/verifier build
echo "[sentry-runtime] validating entry..."
test -f "$DEST.tmp/apps/runtime/dist/host.js"
echo ENTRY_OK
echo "$VERSION" > "$DEST.tmp/.sentry-runtime-version"
echo "[sentry-runtime] activating $VERSION ..."
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then rm -rf "$DEST"; fi
rm -rf "$DEST"; mv "$DEST.tmp" "$DEST"
rm -f "$BASE/current"
ln -s "$VERSION" "$BASE/current"
echo "[sentry-runtime] active: $(readlink "$BASE/current")"
