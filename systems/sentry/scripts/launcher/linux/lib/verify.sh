#!/usr/bin/env bash
# lib/verify.sh — real standalone-Node runtime handshake validation.
# Reuses scripts/launcher/linux/runtime-hello.sh; field checks live in
# validateRuntimeHelloLine (launcher-logic.mjs, unit-tested). No providers,
# no keys, no paid calls. Any failure rejects the deployment.
set -u

# Validate <entry> with <node_bin> from <repo>. Prints RUNTIME_HELLO_OK/FAIL.
sentry_verify_runtime() {
  local entry="$1"
  local node_bin="$2"
  local repo="$3"
  local out=""
  out=$(bash "$repo/scripts/launcher/linux/runtime-hello.sh" "$entry" "$node_bin" 2>/dev/null || true)
  local line="$(printf '%s\n' "$out" | grep -m 1 '^\s*{' || true)"
  if [ -z "$line" ]; then
    echo "RUNTIME_HELLO_FAIL=no hello response from $entry"
    return 1
  fi
  "$node_bin" -e '
import(process.argv[1]).then((m) => {
  const r = m.validateRuntimeHelloLine(process.argv[2] || "");
  if (r.ok) { console.log("RUNTIME_HELLO_OK node=" + r.nodeVersion); process.exit(0); }
  console.log("RUNTIME_HELLO_FAIL=" + r.reason); process.exit(4);
}).catch((e) => { console.log("RUNTIME_HELLO_FAIL=logic error"); process.exit(5); });
' -- "$(sentry_file_url "$repo/scripts/launcher/launcher-logic.mjs")" "$line"
}

