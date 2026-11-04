#!/usr/bin/env bash
# lib/broker.sh — Sentry CLI broker liveness probe (no app start).
# Mirrors cliPipePath/cliPipeScope (@qa/shared cli-ipc.ts):
#   scope = sha1(lowercase($HOME/.local/share/sentry/launcher))[0:12]
#   path = ${TMPDIR:-/tmp}/sentry-cli-v1-<scope>.sock
# A socket FILE alone never proves liveness: only a completed
# hello/welcome handshake reports alive (stale files report stopped).
set -u

# Print the broker socket path for the current user.
sentry_broker_socket() {
  local base="$HOME/.local/share"
  local scoped=""
  scoped=$(printf '%s/sentry/launcher' "$base" | tr '[:upper:]' '[:lower:]')
  local scope=""
  scope=$(printf '%s' "$scoped" | sha1sum 2>/dev/null | cut -c1-12 || true)
  if [ -z "$scope" ]; then return 1; fi
  local tmp="${TMPDIR:-/tmp}"
  printf '%s/sentry-cli-v1-%s.sock\n' "$tmp" "$scope"
}

# Probe liveness. Prints BROKER_ALIVE or BROKER_STOPPED:<reason>.
sentry_broker_probe() {
  local sock="$1"
  if [ ! -e "$sock" ]; then
    echo "BROKER_STOPPED:no socket"
    return 1
  fi
  local hello='{"type":"hello","protocolVersion":1,"client":{"type":"cli","name":"sentry-status"}}'
  if command -v node >/dev/null 2>&1; then
    if node -e '
const net = require("net");
const sockPath = process.argv[1];
const hello = process.argv[2];
const LF = String.fromCharCode(10);
let buf = "";
let done = false;
const finish = (code, msg) => { if (!done) { done = true; if (msg) console.log(msg); process.exit(code); } };
const s = net.connect(sockPath);
s.setTimeout(5000);
s.on("connect", () => { s.end(hello + LF); });
s.on("data", (c) => { buf += c.toString("utf8"); if (buf.indexOf(LF) >= 0) { s.destroy(); finish(buf.indexOf("welcome") >= 0 ? 0 : 1, "HANDSHAKE"); } });
s.on("timeout", () => { s.destroy(); finish(1); });
s.on("error", () => finish(1));
s.on("close", () => finish(1));
' -- "$sock" "$hello" 2>/dev/null | grep -q '^HANDSHAKE$'; then
      echo "BROKER_ALIVE"
      return 0
    fi
    echo "BROKER_STOPPED:handshake failed"
    return 1
  fi
  if command -v socat >/dev/null 2>&1; then
    if printf '%s\n' "$hello" | timeout 5 socat - "UNIX-CONNECT:$sock" 2>/dev/null | grep -q '"welcome"'; then
      echo "BROKER_ALIVE"
      return 0
    fi
    echo "BROKER_STOPPED:handshake failed"
    return 1
  fi
  echo "BROKER_STOPPED:no probe tool (node/socat missing)"
  return 1
}

