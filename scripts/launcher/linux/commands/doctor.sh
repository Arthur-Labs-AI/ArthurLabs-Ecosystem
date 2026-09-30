#!/usr/bin/env bash
# commands/doctor.sh — non-destructive native diagnostics (CachyOS).
# Never prints secrets: versions/paths/presence only. Exit 1 on any FAIL.
set -u

cmd_doctor() {
  local repo="$REPO_ROOT"
  local linux_dir="$repo/scripts/launcher/linux"
  local results_file="$(mktemp)"
  trap 'rm -f "$results_file"' RETURN
  doctor_add() { printf '%s|%s|%s\n' "$1" "$2" "${3:-}" >> "$results_file"; }

  echo ""
  echo "Sentry doctor (CachyOS)"

  echo "Host"
  echo "----"
  local gated_ok=1
  if sentry_require_cachyos >/dev/null 2>&1; then
    doctor_add "CachyOS detected" PASS "$(sentry_os_pretty)"
  else
    doctor_add "CachyOS detected" FAIL "$(sentry_os_pretty): native support targets CachyOS only"
    gated_ok=0
  fi

  echo "Repository"
  echo "----------"
  local gitver=""
  gitver=$(git --version 2>/dev/null || true)
  if [ -n "$gitver" ]; then doctor_add "Git" PASS "$gitver"; else doctor_add "Git" FAIL "not on PATH"; fi
  local top=""
  top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$top" ]; then doctor_add "Repository" PASS "$top"; else doctor_add "Repository" FAIL "not a git checkout"; fi
  local porcelain=""
  porcelain=$(git -C "$repo" status --porcelain 2>/dev/null || true)
  if [ -z "$porcelain" ]; then doctor_add "Working tree" PASS "clean"; else doctor_add "Working tree" WARN "local changes present"; fi

  echo "Runtime"
  echo "-------"
  local node_bin=""
  if [ -n "${SENTRY_NODE_BINARY:-}" ] && [ -x "$SENTRY_NODE_BINARY" ]; then
    node_bin="$SENTRY_NODE_BINARY"
  elif command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  fi
  if [ -n "$node_bin" ]; then
    local nver=""
    nver=$("$node_bin" --version 2>/dev/null || true)
    local nmajor="$(printf '%s' "$nver" | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\)\..*/\1/p' | head -n 1)"
    if [ -n "$nmajor" ] && [ "$nmajor" -ge 22 ]; then
      doctor_add "Node" PASS "$nver ($node_bin)"
    else
      doctor_add "Node" FAIL "$nver (< 22): sudo pacman -S --needed nodejs npm"
    fi
  else
    doctor_add "Node" FAIL "missing: sudo pacman -S --needed nodejs npm"
  fi
  local entry="$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
  if [ -f "$entry" ]; then
    doctor_add "Runtime entry" PASS "$entry"
    local hello_out=""
    if hello_out=$(sentry_verify_runtime "$entry" "${node_bin:-node}" "$repo" 2>/dev/null) && printf '%s\n' "$hello_out" | grep -q '^RUNTIME_HELLO_OK'; then
      doctor_add "runtime.hello handshake" PASS "$(printf '%s\n' "$hello_out" | head -n 1)"
    else
      doctor_add "runtime.hello handshake" FAIL "handshake failed"
    fi
  else
    doctor_add "Runtime entry" FAIL "none deployed (run: sentry setup)"
  fi
  local current="$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)"
  doctor_add "Deployed runtime" "$([ "$current" != "NONE" ] && echo PASS || echo FAIL)" "$current"

  echo "System"
  echo "------"
  if [ "$gated_ok" = "1" ]; then
    local sys_state="$(bash "$linux_dir/check-systemd.sh" | tail -n 1)"
    case "$sys_state" in
      SYSTEMD_OK) doctor_add "systemd user manager" PASS "ready" ;;
      SYSTEMD_BIN_MISSING) doctor_add "systemd user manager" FAIL "systemd binaries missing" ;;
      *)
        doctor_add "systemd user manager" FAIL "not responding ($sys_state): sudo loginctl enable-linger $USER, then rerun"
        ;;
    esac
    local sandbox_out="$(bash "$linux_dir/check-sandbox.sh")"
    if printf '%s\n' "$sandbox_out" | grep -q '^HAVE-socat$'; then
      doctor_add "socat" PASS "$(printf '%s\n' "$sandbox_out" | grep '^SOCAT_VERSION=' | head -n 1)"
    else
      doctor_add "socat" FAIL "not installed (GLM sandbox requires it): sudo pacman -S --needed socat"
    fi
    if printf '%s\n' "$sandbox_out" | grep -q '^HAVE-bubblewrap$'; then
      doctor_add "bubblewrap" PASS "$(printf '%s\n' "$sandbox_out" | grep '^BWRAP_VERSION=' | head -n 1)"
    else
      doctor_add "bubblewrap" FAIL "not installed (GLM sandbox requires it): sudo pacman -S --needed bubblewrap"
    fi
    if printf '%s\n' "$sandbox_out" | grep -q '^SANDBOX_INIT_OK$'; then
      doctor_add "Sandbox init" PASS "bubblewrap smoke passed (no model contact)"
    else
      doctor_add "Sandbox init" FAIL "bubblewrap cannot initialize: $(printf '%s\n' "$sandbox_out" | grep '^SANDBOX_INIT_FAIL' | head -n 1)"
    fi
  else
    doctor_add "systemd user manager" WARN "skipped: unsupported host"
    doctor_add "sandbox" WARN "skipped: unsupported host"
  fi

  echo "Agents"
  echo "------"
  if [ "$gated_ok" = "1" ] && [ -n "$node_bin" ]; then
    local pinned_oc="$(sentry_logic_pin "$repo" PINNED_OPENCODE_VERSION || true)"
    local oc_out="$(bash "$linux_dir/check-opencode.sh")"
    if [ -n "$pinned_oc" ] && printf '%s\n' "$oc_out" | grep -q "$pinned_oc"; then
      doctor_add "OpenCode executable" PASS "$pinned_oc preflight-probed"
    elif printf '%s\n' "$oc_out" | grep -q 'ABSENT'; then
      doctor_add "OpenCode executable" FAIL "not installed (run: sentry setup)"
    else
      doctor_add "OpenCode executable" WARN "untested version"
    fi
    local expected_ds="$(sed -n "s/.*DEEPSEEK_SDK_VERSION = '\([^']*\)'.*/\1/p" "$repo/packages/harness-deepseek/src/sdk.ts" | head -n 1)"
    local ds_out="$(bash "$linux_dir/check-deepseek.sh" "$expected_ds")"
    if printf '%s\n' "$ds_out" | grep -q 'DSH_OK'; then
      doctor_add "DeepSeek runtime" PASS "$expected_ds managed, preflight-probed"
    elif printf '%s\n' "$ds_out" | grep -q 'DSH_DRIFT'; then
      doctor_add "DeepSeek runtime" FAIL "managed binary version drift"
    elif printf '%s\n' "$ds_out" | grep -q 'DSH_BROKEN'; then
      doctor_add "DeepSeek runtime" FAIL "managed binary does not execute"
    else
      doctor_add "DeepSeek runtime" FAIL "managed dsh executable missing"
    fi
    local pinned_cc="$(sentry_logic_pin "$repo" PINNED_CLAUDE_CODE_VERSION || true)"
    local cl_out="$(bash "$linux_dir/check-claude.sh" "$pinned_cc")"
    if printf '%s\n' "$cl_out" | grep -q 'MANAGED_OK'; then
      doctor_add "Claude Code" PASS "$pinned_cc Sentry-managed native Linux"
    elif printf '%s\n' "$cl_out" | grep -q 'PATH_OK' && printf '%s\n' "$cl_out" | grep -q 'PATH_NATIVE=linux'; then
      doctor_add "Claude Code" PASS "$pinned_cc existing native install (global untouched)"
    elif printf '%s\n' "$cl_out" | grep -q '2.1.276'; then
      doctor_add "Claude Code" FAIL "known-incompatible 2.1.276; Sentry-managed $pinned_cc required"
    elif printf '%s\n' "$cl_out" | grep -q 'windows-mount'; then
      doctor_add "Claude Code" FAIL "Windows mount on PATH; Sentry-managed native binary required"
    else
      doctor_add "Claude Code" FAIL "no usable $pinned_cc binary"
    fi
  else
    doctor_add "Agent tools" WARN "skipped: unsupported host or missing node"
  fi

  echo "Desktop"
  echo "-------"
  if [ -f "$repo/apps/desktop/dist/main/index.js" ] && [ -f "$repo/apps/desktop/dist/renderer/index.html" ]; then
    doctor_add "Desktop build" PASS "dist present"
  else
    doctor_add "Desktop build" FAIL "run: sentry setup"
  fi
  local exe="$(sentry_electron_binary "$repo")"
  if [ -n "$exe" ]; then doctor_add "Electron binary" PASS "present"; else doctor_add "Electron binary" FAIL "missing"; fi

  echo "CLI broker"
  echo "----------"
  local sock="$(sentry_broker_socket 2>/dev/null || true)"
  if [ -n "$sock" ]; then
    if sentry_broker_probe "$sock" >/dev/null 2>&1; then
      doctor_add "CLI broker" PASS "running ($sock)"
    else
      doctor_add "CLI broker" INFO "not running (sentry open to start)"
    fi
  else
    doctor_add "CLI broker" INFO "socket path unavailable"
  fi

  echo "Credentials"
  echo "-----------"
  # Presence-only credential signal (values never printed, never stored).
  local cred_present="" 
  if [ -n "$exe" ]; then
    cred_present=$( (cd "$repo/apps/desktop" && timeout 120 "$exe" . --sentry-credential-status 2>/dev/null || true) | grep -m 1 -c 'SENTRY_CREDENTIAL_STATUS=' || true)
  fi
  if [ "$cred_present" = "1" ]; then
    doctor_add "Provider credentials" INFO "Desktop reports presence; manage values in Settings -> Providers"
  else
    doctor_add "Provider credentials" INFO "verify in Desktop -> Settings -> Providers"
  fi

  echo ""
  echo "Sentry doctor"
  local line name level detail fails=0 warns=0
  while IFS='|' read -r name level detail; do
    [ -n "$name" ] || continue
    if [ "$level" = "PASS" ]; then echo "  [PASS] $name — $detail";
    elif [ "$level" = "WARN" ]; then echo "  [WARN] $name — $detail"; warns=$((warns + 1));
    elif [ "$level" = "INFO" ]; then echo "  [INFO] $name — $detail";
    else echo "  [FAIL] $name — $detail"; fails=$((fails + 1)); fi
  done < "$results_file"
  echo ""
  if [ "$fails" -eq 0 ]; then
    echo "Doctor result: READY (core infrastructure)"
    if [ "$warns" -gt 0 ]; then echo "Configuration: some provider credentials are missing — configure them in Desktop Settings -> Providers."; fi
    return 0
  fi
  echo "Doctor result: NOT READY"
  echo "See docs/setup/cachyos-launcher.md. Never paste API keys into bug reports."
  return 1
}

