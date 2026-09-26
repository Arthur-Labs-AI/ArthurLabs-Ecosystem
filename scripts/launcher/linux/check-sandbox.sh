#!/usr/bin/env bash
# GLM/Claude Code sandbox prerequisite probe (no model contact, no network).
# Reports presence, versions, and whether bubblewrap can actually initialize
# a minimal sandbox. Never disables or weakens sandboxing: missing pieces
# are reported so setup/doctor can fail closed with an actionable message.
set -u
if command -v socat >/dev/null 2>&1; then
  echo 'HAVE-socat'
  echo "SOCAT_VERSION=$(socat -V 2>&1 | head -n 1)"
else
  echo 'MISS-socat'
fi
if command -v bwrap >/dev/null 2>&1; then
  echo 'HAVE-bwrap'
  echo "BWRAP_VERSION=$(bwrap --version 2>&1 | head -n 1)"
else
  echo 'MISS-bwrap'
fi
if command -v bwrap >/dev/null 2>&1; then
  if bwrap --ro-bind /usr /usr --proc /proc --dev /dev /usr/bin/true >/dev/null 2>&1; then
    echo 'SANDBOX_INIT_OK'
  else
    echo 'SANDBOX_INIT_FAIL=user-namespaces-or-mounts-unavailable'
  fi
else
  echo 'SANDBOX_INIT_FAIL=bwrap-missing'
fi
