#!/usr/bin/env bash
# Print HAVE-<bin> / MISS-<pkg> lines for each required tool.
set -u
check() {
  bin="$1"; pkg="$2"
  if command -v "$bin" >/dev/null 2>&1; then echo "HAVE-$pkg"; else echo "MISS-$pkg"; fi
}
check git git
check curl curl
check update-ca-certificates ca-certificates
check bwrap bwrap
if [ "${1:-}" = "with-socat" ]; then check socat socat; fi
