#!/usr/bin/env bash
# Sentry WSL runtime deploy (inner, runs inside Linux).
# Source-clean: only root-level build metadata is copied (never apps/,
# packages/, node_modules/, dist/, .turbo, .git from Windows). Workspace
# sources sync via tar with explicit excludes; a clean-tree assertion
# guarantees ZERO inherited node_modules/dist before the Linux install.
# Build uses the monorepo graph (turbo --filter=@qa/runtime...) so every
# transitive workspace dependency builds natively in Linux.
# Activation is atomic: build+validate happen before `current` moves.
set -euo pipefail
SRC="$1"; VERSION="$2"
BASE="$HOME/.local/share/sentry/runtime"
DEST="$BASE/$VERSION"
mkdir -p "$BASE"
echo "[sentry-runtime] staging $VERSION ..."
rm -rf "$DEST.tmp"; mkdir -p "$DEST.tmp"
cd "$SRC"
echo '[sentry-runtime] copying root build metadata (files only)...'
for e in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc tsconfig.base.json turbo.json eslint.config.js prettier.config.js; do
  if [ -f "$e" ]; then cp --no-preserve=all "$e" "$DEST.tmp/"; else echo "[sentry-runtime] note: root file missing: $e"; fi
done
echo '[sentry-runtime] syncing workspace sources (excluding node_modules/dist/.turbo/coverage)...'
mkdir -p "$DEST.tmp/apps" "$DEST.tmp/packages"
EXCLUDES=(--exclude=node_modules --exclude=dist --exclude=.turbo --exclude=coverage '--exclude=*.tsbuildinfo' --exclude=.tsbuildinfo)
# GNU tar exits 1 when files change mid-archive (e.g. an IDE/test run touches
# the tree during staging). That is tolerated here: the clean-tree assertion,
# frozen install, full Linux build, entry validation, and handshake below
# still gate activation — a genuinely corrupt stage fails loudly there.
# Exit >= 2 (real tar errors) aborts the deploy.
sync_one() {
  src="$1"; dest="$2"
  (cd "$src" && tar "${EXCLUDES[@]}" --warning=no-file-changed -cf - .) | tar -xf - -C "$dest"
  # NOTE: copy PIPESTATUS atomically — even a bare assignment resets it.
  pipe_codes=("${PIPESTATUS[@]}")
  archive_code=${pipe_codes[0]}; extract_code=${pipe_codes[1]}
  if [ "$archive_code" -ge 2 ]; then echo "[sentry-runtime] FATAL: tar archive failed ($archive_code) for $src"; return 1; fi
  if [ "$extract_code" -ne 0 ]; then echo "[sentry-runtime] FATAL: tar extract failed ($extract_code) for $src"; return 1; fi
  return 0
}
for a in apps/*/; do
  n=$(basename "$a")
  mkdir -p "$DEST.tmp/apps/$n"
  sync_one "$a" "$DEST.tmp/apps/$n"
done
for p in packages/*/; do
  n=$(basename "$p")
  mkdir -p "$DEST.tmp/packages/$n"
  sync_one "$p" "$DEST.tmp/packages/$n"
done
echo SYNC_OK
echo '[sentry-runtime] asserting clean Linux staging (no Windows artifacts)...'
STAGED_JUNK=$(cd "$DEST.tmp" && find apps packages \( -name node_modules -o -name dist \) 2>/dev/null | head -20 || true)
if [ -n "$STAGED_JUNK" ]; then
  echo '[sentry-runtime] FATAL: staged tree contains inherited artifacts:'
  echo "$STAGED_JUNK"
  rm -rf "$DEST.tmp"
  exit 10
fi
echo STAGE_CLEAN_OK
cd "$DEST.tmp"
export CI=true
echo "[sentry-runtime] installing Linux dependencies (frozen lockfile)..."
pnpm install --frozen-lockfile
echo '[sentry-runtime] building runtime + transitive workspace dependencies (monorepo graph)...'
pnpm exec turbo run build --filter=@qa/runtime...
echo '[sentry-runtime] validating entry...'
test -f "$DEST.tmp/apps/runtime/dist/host.js"
echo ENTRY_OK
echo "$VERSION" > "$DEST.tmp/.sentry-runtime-version"
echo "[sentry-runtime] activating $VERSION ..."
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then rm -rf "$DEST"; fi
rm -rf "$DEST"; mv "$DEST.tmp" "$DEST"
rm -f "$BASE/current"
ln -s "$VERSION" "$BASE/current"
echo "[sentry-runtime] active: $(readlink "$BASE/current")"
