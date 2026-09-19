set -euo pipefail
SRC="$1"; VERSION="$2"
DEST="$HOME/.local/share/sentry/runtime/$VERSION"
mkdir -p "$HOME/.local/share/sentry/runtime"
echo "[sentry-runtime] syncing tree..."
rm -rf "$DEST.tmp"; mkdir -p "$DEST.tmp"
cd "$SRC"
for e in * .npmrc .nvmrc pnpm-workspace.yaml package.json tsconfig.base.json turbo.json eslint.config.js prettier.config.js; do
  [ -e "$e" ] || continue
  cp -a "$e" "$DEST.tmp/"
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
echo "[sentry-runtime] installing Linux dependencies..."
pnpm install --prefer-offline --no-frozen-lockfile
echo "[sentry-runtime] building runtime packages..."
pnpm --filter @qa/runtime-protocol --filter @qa/runtime build
echo "[sentry-runtime] activating..."
rm -rf "$DEST"; mv "$DEST.tmp" "$DEST"
rm -f "$HOME/.local/share/sentry/runtime/current"
ln -s "$VERSION" "$HOME/.local/share/sentry/runtime/current"
test -f "$DEST/apps/runtime/dist/host.js" && echo ENTRY_OK
