#!/usr/bin/env bash
# Install the Sentry-managed DeepSeek CLI (no sudo, no network, no globals).
# Resolves the pinned DSH entry from the active runtime, verifies its
# identity, and exposes it at tools/deepseek/bin/dsh via a stable symlink.
# $1 = expected version (e.g. 0.1.5-rc.2).
set -euo pipefail
EXPECTED="$1"
TOOLS="$HOME/.local/share/sentry/tools/deepseek"
RT=$(readlink -f "$HOME/.local/share/sentry/runtime/current")
ENTRY=$(find -L "$RT" -path '*@deepseek-ai/dsh/lib/bin.js' 2>/dev/null | head -n 1)
[ -n "$ENTRY" ] || { echo DSH_ENTRY_MISSING; exit 5; }
PKG=$(dirname "$(dirname "$ENTRY")")/package.json
VER=$(node -p "require('$PKG').version")
if [ "$VER" != "$EXPECTED" ]; then echo "DSH_ENTRY_DRIFT want=$EXPECTED got=$VER"; exit 6; fi
OUT=$(node "$ENTRY" --version 2>&1 | head -n 1)
[ "$OUT" = "$EXPECTED" ] || { echo "DSH_ENTRY_PROBE_FAIL got=$OUT"; exit 7; }
mkdir -p "$TOOLS/bin"
ln -sfn "$ENTRY" "$TOOLS/entry"
cat > "$TOOLS/bin/dsh" <<'WRAPPER'
#!/usr/bin/env bash
# Sentry-managed DeepSeek CLI. Executes the pinned DSH runtime from the
# active Sentry runtime; preserves argv and exit code; needs no shell
# profiles and carries no credentials.
set -euo pipefail
LINK="$HOME/.local/share/sentry/tools/deepseek/entry"
if [ -x "$LINK" ]; then exec "$LINK" "$@"; fi
RT_FALLBACK=$(readlink -f "$HOME/.local/share/sentry/runtime/current")
ENTRY_FALLBACK=$(find -L "$RT_FALLBACK" -path '*@deepseek-ai/dsh/lib/bin.js' 2>/dev/null | head -n 1)
[ -n "$ENTRY_FALLBACK" ] || { echo "sentry-managed dsh not found" >&2; exit 127; }
exec node "$ENTRY_FALLBACK" "$@"
WRAPPER
chmod +x "$TOOLS/bin/dsh"
"$TOOLS/bin/dsh" --version
echo "MANAGED_DSH=$TOOLS/bin/dsh"
