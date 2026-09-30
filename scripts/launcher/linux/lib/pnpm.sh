#!/usr/bin/env bash
# lib/pnpm.sh — pinned pnpm for native setup/update (no global mutation).
# Order: exact PATH match -> corepack -> user-scoped npm prefix. The prefix
# bin dir is exported for the current setup/update process and recorded in
# the launcher config so update reuses the same mechanism.
set -u

# Ensure a working pnpm at the pinned version. Prints PNPM_* facts.
sentry_ensure_pnpm() {
  local root="$1"
  local pin="$(sentry_pinned_pnpm "$root")"
  local have=""
  have=$(pnpm --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
  if [ "$have" = "$pin" ]; then
    echo "  [OK] pnpm $have"
    echo "PNPM_RESOLVED=$(command -v pnpm)"
    return 0
  fi
  if [ -n "$have" ]; then
    echo "  [!] pnpm $have differs from pinned $pin; provisioning pinned pnpm"
  fi
  if command -v corepack >/dev/null 2>&1; then
    echo "  Activating pinned pnpm $pin through corepack..."
    if COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@$pin" --activate >/dev/null 2>&1; then
      have=$(pnpm --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
      if [ "$have" = "$pin" ]; then
        echo "  [OK] pnpm $have (corepack)"
        echo "PNPM_RESOLVED=$(command -v pnpm)"
        return 0
      fi
    fi
    echo "  [!] corepack activation did not yield pnpm $pin"
  fi
  if command -v npm >/dev/null 2>&1; then
    local prefix="$HOME/.local/share/sentry/tools/pnpm"
    echo "  Installing pinned pnpm $pin user-scoped ($prefix)..."
    if npm install --prefix "$prefix" "pnpm@$pin" >/dev/null 2>&1; then
      export PATH="$prefix/bin:$PATH"
      have=$(pnpm --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
      if [ "$have" = "$pin" ]; then
        echo "  [OK] pnpm $have (user-scoped)"
        echo "PNPM_RESOLVED=$(command -v pnpm)"
        echo "PNPM_PREFIX=$prefix"
        return 0
      fi
    fi
  fi
  echo "  [X] Could not provision pnpm $pin (need corepack or npm)"
  return 1
}

