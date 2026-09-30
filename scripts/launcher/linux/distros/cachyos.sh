#!/usr/bin/env bash
# distros/cachyos.sh — CachyOS (pacman) package adapter.
# The ONLY pacman knowledge in the launcher lives here. Generic checks
# stay in check-*.sh; the executable->package table mirrors CACHYOS_PACKAGES
# in scripts/launcher/launcher-logic.mjs (see test-package-map-sync.sh).
# Package names are Arch extra/core names shared by CachyOS.
set -u

# Capability list for setup: executable/capability tokens (NOT package names).
# The adapter converts node -> nodejs, bwrap -> bubblewrap, socat -> socat.
# ca-certificates has no executable and is package-checked by design.
SENTRY_CACHYOS_CAPABILITIES=(git curl ca-certificates node npm bwrap socat)

# Map a probed executable/capability to its pacman package. Returns 1 when unknown.
sentry_cachyos_package_for() {
  case "$1" in
    git) printf '%s\n' "git" ;;
    curl) printf '%s\n' "curl" ;;
    ca-certificates) printf '%s\n' "ca-certificates" ;;
    node) printf '%s\n' "nodejs" ;;
    npm) printf '%s\n' "npm" ;;
    bwrap) printf '%s\n' "bubblewrap" ;;
    socat) printf '%s\n' "socat" ;;
    *) return 1 ;;
  esac
}

# Print missing pacman packages (one per line) for needed executables.
# 'ca-certificates' has no executable: it is checked via pacman -Qq.
sentry_cachyos_missing() {
  local miss=()
  local name pkg
  for name in "$@"; do
    pkg="$(sentry_cachyos_package_for "$name")" || continue
    if [ "$name" = "ca-certificates" ]; then
      pacman -Qq "$pkg" >/dev/null 2>&1 || miss+=("$pkg")
    else
      command -v "$name" >/dev/null 2>&1 || miss+=("$pkg")
    fi
  done
  if [ "${#miss[@]}" -gt 0 ]; then printf '%s\n' "${miss[@]}"; fi
  return 0
}

# Print the exact privileged command that would install the packages.
sentry_cachyos_install_cmd() {
  printf 'sudo pacman -S --needed'
  local pkg
  for pkg in "$@"; do printf ' %s' "$pkg"; done
  printf '\n'
}

# Install packages with explicit user consent. Never silent sudo: with
# SENTRY_NON_INTERACTIVE=1 (or no TTY) the command is printed and setup
# fails closed instead of prompting.
sentry_cachyos_install() {
  local cmd="$(sentry_cachyos_install_cmd "$@")"
  if [ "${SENTRY_NON_INTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    echo "Missing system packages: $*"
    echo "Run (CachyOS): $cmd"
    return 1
  fi
  echo "Missing system packages: $*"
  local answer=""
  read -r -p "Run '$cmd' with sudo now? [y/N] " answer || true
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "Declined. Run this yourself, then rerun: sentry setup"
      echo "  $cmd"
      return 1
      ;;
  esac
  sudo pacman -S --needed "$@"
}

