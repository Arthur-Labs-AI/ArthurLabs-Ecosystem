#!/usr/bin/env bash
# Print HAVE-<pkg> / MISS-<pkg> lines for required host tools.
# socat and bubblewrap are first-class sandbox prerequisites: the pinned
# Claude Code sandbox (fail-closed) requires both at runtime.
set -u
check() {
  bin="$1"; pkg="$2"
  if command -v "$bin" >/dev/null 2>&1; then echo "HAVE-$pkg"; else echo "MISS-$pkg"; fi
}
check git git
check curl curl
check update-ca-certificates ca-certificates
check bwrap bwrap
check socat socat
