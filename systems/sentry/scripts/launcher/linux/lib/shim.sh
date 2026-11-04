#!/usr/bin/env bash
# lib/shim.sh — user-level `sentry` command (symlink, no root, no rc edits).
set -u

# Install/update ~/.local/bin/sentry -> <repo>/sentry. Prints SHIM_* facts.
sentry_install_shim() {
  local repo="$1"
  local bindir="$HOME/.local/bin"
  mkdir -p "$bindir"
  ln -sfn "$repo/sentry" "$bindir/sentry"
  echo "SHIM_PATH=$bindir/sentry"
  echo "SHIM_TARGET=$repo/sentry"
  case ":$PATH:" in
    *":$bindir:"*)
      echo "  [OK] sentry command installed (user PATH)"
      ;;
    *)
      echo "  [!] $bindir is not in PATH; add it to use 'sentry' anywhere:"
      echo "      export PATH=\"$bindir:\$PATH\""
      ;;
  esac
  return 0
}

