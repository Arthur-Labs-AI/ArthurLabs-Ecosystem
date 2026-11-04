#!/usr/bin/env bash
# Report Linux host dependencies as HAVE-<package> / MISS-<package>.
# Names are Ubuntu PACKAGE names (what apt installs), not executables:
#   executable bwrap  -> package bubblewrap
#   executable socat  -> package socat
# Probes use the executables; output uses the package for installation.
set -u
check() {
  bin="$1"; pkg="$2"
  if command -v "$bin" >/dev/null 2>&1; then echo "HAVE-$pkg"; else echo "MISS-$pkg"; fi
}
check git git
check curl curl
check update-ca-certificates ca-certificates
check bwrap bubblewrap
check socat socat
