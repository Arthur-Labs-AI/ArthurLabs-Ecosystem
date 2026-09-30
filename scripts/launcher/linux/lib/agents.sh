#!/usr/bin/env bash
# lib/agents.sh — managed agent tooling provision (check first, install on
# drift, persist binary paths). Shared by setup and post-update so a pin
# change is never silently left stale. Emits AGENTS_* readiness flags.
# Installers are rootless user prefixes; persistence warns and continues.
set -u

# Provision OpenCode/DeepSeek/Claude Code for <repo>. Prints human lines
# plus AGENTS_OPENCODE/AGENTS_DEEPSEEK/AGENTS_CLAUDE=(0|1).
sentry_provision_agents() {
  local repo="$1"
  local linux_dir="$repo/scripts/launcher/linux"
  local oc_ready=0 ds_ready=0 cc_ready=0
  local pinned_oc="$(sentry_logic_pin "$repo" PINNED_OPENCODE_VERSION || true)"
  if [ -z "$pinned_oc" ]; then sentry_fail "Could not read the pinned OpenCode version."; return 1; fi
  local oc_out="$(bash "$linux_dir/check-opencode.sh")"
  if printf '%s\n' "$oc_out" | grep -q "$pinned_oc"; then
    sentry_ok "OpenCode $pinned_oc"
    oc_ready=1
  else
    echo "  Installing tested OpenCode $pinned_oc into the Sentry-managed location..."
    if bash "$linux_dir/install-opencode.sh" "$pinned_oc" 2>&1 | tail -n 2; then
      if bash "$linux_dir/check-opencode.sh" | grep -q "$pinned_oc"; then
        sentry_ok "OpenCode $pinned_oc (Sentry-managed)"
        oc_ready=1
      fi
    fi
    if [ "$oc_ready" = "0" ]; then
      sentry_warn "OpenCode could not be installed automatically. OpenCode runs stay unavailable until it is installed."
    fi
  fi
  local expected_ds="$(sed -n "s/.*DEEPSEEK_SDK_VERSION = '\([^']*\)'.*/\1/p" "$repo/packages/harness-deepseek/src/sdk.ts" | head -n 1)"
  if [ -z "$expected_ds" ]; then expected_ds="$(sentry_logic_pin "$repo" PINNED_DEEPSEEK_SDK_VERSION || true)"; fi
  if [ -z "$expected_ds" ]; then sentry_fail "Could not read the pinned DeepSeek version."; return 1; fi
  echo "  Preparing Sentry-managed DeepSeek runtime $expected_ds (from the deployed runtime; no sudo, no network)..."
  local ds_out=""
  if ds_out=$(bash "$linux_dir/install-deepseek-tool.sh" "$expected_ds" 2>&1) && printf '%s\n' "$ds_out" | grep -q "$expected_ds"; then
    local managed_ds="$(printf '%s\n' "$ds_out" | sed -n 's/^MANAGED_DSH=//p' | head -n 1)"
    sentry_ok "DeepSeek runtime $expected_ds (managed, preflight-probed)"
    if [ -n "$managed_ds" ]; then sentry_desktop_persist_binary "$repo" SENTRY_DEEPSEEK_BINARY "$managed_ds" || true; fi
    ds_ready=1
  else
    sentry_fail "DeepSeek managed runtime could not be prepared. DeepSeek runs are unavailable."
    echo "  Rerun sentry setup after redeploying the runtime (sentry doctor shows details)."
  fi
  local pinned_cc="$(sentry_logic_pin "$repo" PINNED_CLAUDE_CODE_VERSION || true)"
  if [ -z "$pinned_cc" ]; then sentry_fail "Could not read the pinned Claude Code version."; return 1; fi
  local cl_out="$(bash "$linux_dir/check-claude.sh" "$pinned_cc")"
  if printf '%s\n' "$cl_out" | grep -q 'MANAGED_OK'; then
    local managed_cc="$(printf '%s\n' "$cl_out" | sed -n 's/^MANAGED=//p' | head -n 1)"
    # The managed layout is NOT on normal PATH and the runtime has no
    # data-root fallback for it: without a persisted SENTRY_GLM_BINARY the
    # runtime cannot resolve this binary, so persistence gates readiness.
    if [ -n "$managed_cc" ] && [ "$managed_cc" != "missing" ] && sentry_desktop_persist_binary "$repo" SENTRY_GLM_BINARY "$managed_cc"; then
      sentry_ok "Claude Code $pinned_cc (Sentry-managed native Linux)"
      cc_ready=1
    else
      sentry_warn "Managed Claude Code is installed, but its binary path could not be persisted."
      sentry_warn "GLM runs remain unavailable until SENTRY_GLM_BINARY is configured."
    fi
  elif printf '%s\n' "$cl_out" | grep -q 'PATH_OK' && printf '%s\n' "$cl_out" | grep -q 'PATH_NATIVE=linux'; then
    local reuse_cc="$(printf '%s\n' "$cl_out" | sed -n 's/^PATH_CLAUDE=//p' | head -n 1)"
    if [ -n "$reuse_cc" ] && [ "$reuse_cc" != "MISSING" ] && sentry_desktop_persist_binary "$repo" SENTRY_GLM_BINARY "$reuse_cc"; then
      sentry_ok "Claude Code $pinned_cc (reusing existing native install; global untouched)"
      cc_ready=1
    elif [ -n "$reuse_cc" ] && [ "$reuse_cc" != "MISSING" ] && [ -x "$reuse_cc" ] && "$reuse_cc" --version 2>/dev/null | grep -q "$pinned_cc"; then
      # Persistence failed, but this exact absolute binary is executable
      # and version-matched right now: it resolves via runtime PATH
      # independently of PATH inheritance, so readiness holds with a warning.
      sentry_warn "Claude Code path not persisted; reusing $reuse_cc from PATH."
      sentry_ok "Claude Code $pinned_cc (reusing existing native install; global untouched)"
      cc_ready=1
    else
      sentry_warn "Claude Code on PATH is not provably usable; GLM runs stay unavailable."
    fi
  else
    echo "  Installing Sentry-managed Claude Code $pinned_cc (local npm prefix only)..."
    local cl_inst_out=""
    if cl_inst_out=$(bash "$linux_dir/install-claude.sh" "$pinned_cc" 2>&1); then
      printf '%s\n' "$cl_inst_out" | tail -n 2
      local fresh_cc="$(printf '%s\n' "$cl_inst_out" | sed -n 's/^MANAGED_CLAUDE=//p' | head -n 1)"
      # The fresh binary is the ONLY newly resolvable one: validate it
      # (absolute native path, executable, pinned version) and persist it
      # before claiming GLM readiness.
      case "$fresh_cc" in
        /*)
          if [ -x "$fresh_cc" ]; then
            local fresh_ver=""
            fresh_ver=$("$fresh_cc" --version 2>/dev/null | head -n 1 || true)
            if printf '%s\n' "$fresh_ver" | grep -q "$pinned_cc"; then
              sentry_ok "Claude Code $pinned_cc (Sentry-managed)"
              if sentry_desktop_persist_binary "$repo" SENTRY_GLM_BINARY "$fresh_cc"; then
                cc_ready=1
              else
                sentry_warn "Claude Code installed but SENTRY_GLM_BINARY was not persisted; GLM runs stay unavailable until the runtime resolves it."
              fi
            else
              sentry_warn "Fresh Claude Code reports [$fresh_ver], want [$pinned_cc]; GLM runs stay unavailable."
            fi
          else
            sentry_warn "Fresh Claude Code binary is not executable ($fresh_cc); GLM runs stay unavailable."
          fi
          ;;
        *)
          sentry_warn "Fresh Claude Code install reported no usable binary; GLM runs stay unavailable."
          ;;
      esac
    else
      printf '%s\n' "$cl_inst_out" | tail -n 2
      sentry_warn "Claude Code could not be installed automatically."
    fi
  fi
  echo "AGENTS_OPENCODE=$oc_ready"
  echo "AGENTS_DEEPSEEK=$ds_ready"
  echo "AGENTS_CLAUDE=$cc_ready"
  return 0
}
