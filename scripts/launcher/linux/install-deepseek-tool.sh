#!/usr/bin/env bash
# Install the Sentry-managed DeepSeek CLI (no sudo, no network, no globals).
# The wrapper resolves the pinned DSH entry from runtime/current AT EVERY
# INVOCATION, so `sentry update` needs no tool reinstall merely to follow
# the active runtime. Verified against the installed pinned package layout:
#   <runtime>/**/node_modules/@deepseek-ai/dsh/lib/bin.js
# $1 = expected version (e.g. 0.1.5-rc.2).
set -euo pipefail
EXPECTED="$1"
TOOLS="$HOME/.local/share/sentry/tools/deepseek"
RT=$(readlink -f "$HOME/.local/share/sentry/runtime/current")
ENTRY=$(find -L "$RT" -path '*@deepseek-ai/dsh/lib/bin.js' -type f -print -quit 2>/dev/null)
[ -n "$ENTRY" ] || { echo DSH_ENTRY_MISSING; exit 5; }
PKG=$(dirname "$(dirname "$ENTRY")")/package.json
VER=$(node -p "require('$PKG').version")
if [ "$VER" != "$EXPECTED" ]; then echo "DSH_ENTRY_DRIFT want=$EXPECTED got=$VER"; exit 6; fi
OUT=$(node "$ENTRY" --version 2>&1 | head -n 1)
[ "$OUT" = "$EXPECTED" ] || { echo "DSH_ENTRY_PROBE_FAIL got=$OUT"; exit 7; }
mkdir -p "$TOOLS/bin"
# A stale install-time symlink must never shadow runtime/current: remove it.
rm -f "$TOOLS/entry"
cat > "$TOOLS/bin/dsh" <<'WRAPPER'
#!/usr/bin/env bash
# Sentry-managed DeepSeek CLI. Resolves the pinned DSH runtime from the
# ACTIVE Sentry runtime (runtime/current) at every invocation, so runtime
# updates are followed without reinstalling this tool. Preserves argv and
# exit code; needs no shell profiles and carries no credentials.
set -euo pipefail
RT_LIVE=$(readlink -f "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || true)
[ -n "$RT_LIVE" ] && [ -d "$RT_LIVE" ] || { echo "Sentry runtime/current missing" >&2; exit 127; }
ENTRY_LIVE=$(find -L "$RT_LIVE" -path '*@deepseek-ai/dsh/lib/bin.js' -type f -print -quit 2>/dev/null)
[ -n "$ENTRY_LIVE" ] || { echo "Sentry-managed DeepSeek runtime missing" >&2; exit 127; }
exec node "$ENTRY_LIVE" "$@"
WRAPPER
chmod +x "$TOOLS/bin/dsh"
"$TOOLS/bin/dsh" --version
echo "MANAGED_DSH=$TOOLS/bin/dsh"
