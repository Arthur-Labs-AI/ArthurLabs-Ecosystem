#!/usr/bin/env bash
# lib/pnpm.sh — pinned pnpm resolution to an explicit absolute executable.
# Order: exact PATH match -> corepack -> user-scoped npm prefix. The result
# is a machine-readable PNPM_RESOLVED=<absolute path> that callers invoke
# directly ("$pnpm_bin" install ...). Nothing here mutates the caller's
# PATH: command substitution would discard it (subshell), so resolution
# must be explicit, never ambient.
set -u

# Resolve the pinned pnpm to an absolute executable. Prints PNPM_* facts.
sentry_ensure_pnpm() {
  local root="$1"
  local pin="$(sentry_pinned_pnpm "$root")"
  local have=""
  local resolved=""
  have=$(pnpm --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
  if [ "$have" = "$pin" ]; then
    resolved="$(command -v pnpm)"
    resolved="$(readlink -f "$resolved" 2>/dev/null || printf '%s' "$resolved")"
    echo "  [OK] pnpm $have"
    echo "PNPM_RESOLVED=$resolved"
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
        resolved="$(command -v pnpm)"
        resolved="$(readlink -f "$resolved" 2>/dev/null || printf '%s' "$resolved")"
        echo "  [OK] pnpm $have (corepack)"
        echo "PNPM_RESOLVED=$resolved"
        return 0
      fi
    fi
    echo "  [!] corepack activation did not yield pnpm $pin"
  fi
  if command -v npm >/dev/null 2>&1; then
    local prefix="$HOME/.local/share/sentry/tools/pnpm"
    echo "  Installing pinned pnpm $pin user-scoped ($prefix)..."
    if npm install --prefix "$prefix" "pnpm@$pin" >/dev/null 2>&1 && [ -x "$prefix/bin/pnpm" ]; then
      have=$("$prefix/bin/pnpm" --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
      if [ "$have" = "$pin" ]; then
        echo "  [OK] pnpm $have (user-scoped)"
        echo "PNPM_RESOLVED=$prefix/bin/pnpm"
        echo "PNPM_PREFIX=$prefix"
        return 0
      fi
    fi
  fi
  echo "  [X] Could not provision pnpm $pin (need corepack or npm)"
  return 1
}

# Install repo dependencies with an explicit pnpm executable (never bare pnpm).
sentry_pnpm_install() {
  local repo="$1"
  local pnpm_bin="$2"
  echo "  $pnpm_bin install --frozen-lockfile ..."
  if ! (cd "$repo" && "$pnpm_bin" install --frozen-lockfile); then
    sentry_fail "pnpm install failed."
    return 1
  fi
  return 0
}

# Build the repo with an explicit pnpm executable (never bare pnpm).
sentry_pnpm_build() {
  local repo="$1"
  local pnpm_bin="$2"
  echo "  $pnpm_bin build ..."
  if ! (cd "$repo" && "$pnpm_bin" build); then
    sentry_fail "pnpm build failed."
    return 1
  fi
  return 0
}
