#!/usr/bin/env bash
# commands/setup.sh — ordered idempotent native setup (CachyOS).
# Safe to rerun: every phase reuses valid state, installs only what is
# missing, never moves runtime/current until the new deploy validates,
# and never touches credentials, projects, or unrelated packages.
set -u

cmd_setup() {
  local noninteractive=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --non-interactive | --yes) noninteractive=1 ;;
      --list-phases)
        node -e 'import(process.argv[1]).then((m) => console.log(m.setupPhaseNames().join("\n")))' -- "$(sentry_file_url "$REPO_ROOT/scripts/launcher/launcher-logic.mjs")"
        return 0
        ;;
      *)
        echo "Unknown setup flag: $arg" >&2
        return 1
        ;;
    esac
  done
  export SENTRY_NON_INTERACTIVE="$noninteractive"
  # Host gate lives here (not in the router) so --list-phases stays
  # host-independent while every real setup run fails closed off CachyOS.
  sentry_require_cachyos || return 3
  local repo="$REPO_ROOT"
  local linux_dir="$repo/scripts/launcher/linux"
  local version="$(sentry_product_version "$repo")"
  local sha="$(sentry_short_sha "$repo")"
  echo ""
  echo "Sentry v0.1 Beta Setup (product $version, CachyOS)"
  sentry_desktop_ensure_stopped "$repo"

  sentry_section "[1/12] CachyOS host validation"
  sentry_require_cachyos || return 1
  sentry_ok "CachyOS host ($(sentry_os_pretty))"

  sentry_section "[2/12] Base prerequisites"
  local base_missing=""
  base_missing=$(bash "$linux_dir/check-base.sh" | sed -n 's/^MISS-//p' | tr '\n' ' ')
  if [ -n "$(printf '%s' "$base_missing" | tr -d ' ')" ]; then
    sentry_fail "Base Linux utilities missing:$base_missing"
    echo "  These come from standard CachyOS core packages; repair the environment, then rerun setup."
    return 1
  fi
  sentry_ok "Base Linux utilities (bash, find, readlink, timeout, grep, sed)"

  sentry_section "[3/12] System packages"
  local missing_pkgs="$(sentry_cachyos_missing git curl ca-certificates nodejs npm bwrap socat)"
  if [ -n "$missing_pkgs" ]; then
    echo "  Installing missing CachyOS packages (pacman only, nothing removed)..."
    # shellcheck disable=SC2086
    if ! sentry_cachyos_install $missing_pkgs; then return 1; fi
    missing_pkgs="$(sentry_cachyos_missing git curl ca-certificates nodejs npm bwrap socat)"
    if [ -n "$missing_pkgs" ]; then
      sentry_fail "Still missing after install:$missing_pkgs"
      return 1
    fi
    sentry_ok "CachyOS packages installed and verified"
  else
    sentry_ok "CachyOS packages (git, curl, ca-certificates, nodejs, npm, bubblewrap, socat)"
  fi

  sentry_section "[4/12] Node"
  local node_line=""
  node_line=$(sentry_ensure_node) || { printf '%s\n' "$node_line"; return 1; }
  printf '%s\n' "$node_line"
  local node_bin="$(printf '%s\n' "$node_line" | sed -n 's/^SENTRY_NODE_RESOLVED=//p' | head -n 1)"
  if [ -z "$node_bin" ]; then sentry_fail "Node resolution produced no executable."; return 1; fi
  export SENTRY_NODE_BINARY="$node_bin"

  sentry_section "[5/12] pnpm"
  local pnpm_line=""
  pnpm_line=$(sentry_ensure_pnpm "$repo") || { printf '%s\n' "$pnpm_line"; return 1; }
  printf '%s\n' "$pnpm_line"

  sentry_section "[6/12] systemd and sandbox"
  local sys_state="$(bash "$linux_dir/check-systemd.sh" | tail -n 1)"
  case "$sys_state" in
    SYSTEMD_OK) sentry_ok "systemd user services" ;;
    SYSTEMD_BIN_MISSING)
      sentry_fail "systemd executables are absent."
      echo "  Install systemd, then rerun: sentry setup"
      echo "    sudo pacman -S --needed systemd"
      return 1
      ;;
    *)
      sentry_fail "systemd user manager is not responding ($sys_state)."
      echo "  Enable lingering for your user, then rerun: sentry setup"
      echo "    sudo loginctl enable-linger $USER"
      return 1
      ;;
  esac
  local sandbox_missing=""
  sandbox_missing=$(bash "$linux_dir/check-sandbox.sh")
  if ! printf '%s\n' "$sandbox_missing" | grep -q '^HAVE-socat$'; then
    sentry_fail "socat is missing (GLM sandbox requires it)."
    return 1
  fi
  if ! printf '%s\n' "$sandbox_missing" | grep -q '^HAVE-bubblewrap$'; then
    sentry_fail "bubblewrap is missing (GLM sandbox requires it)."
    return 1
  fi
  sentry_ok "Sandbox prerequisites (socat, bubblewrap)"
  if printf '%s\n' "$sandbox_missing" | grep -q '^SANDBOX_INIT_OK$'; then
    sentry_ok "Sandbox init probe passed"
  else
    local detail="$(printf '%s\n' "$sandbox_missing" | grep '^SANDBOX_INIT_FAIL' | head -n 1)"
    sentry_warn "Sandbox init probe did not pass ($detail). GLM runs stay unavailable until it can initialize."
    echo "  Continuing setup; run: sentry doctor"
  fi
  local sandbox_ready=0
  if printf '%s\n' "$sandbox_missing" | grep -q '^SANDBOX_INIT_OK$'; then sandbox_ready=1; fi

  sentry_section "[7/12] Repository dependencies"
  echo "  pnpm install --frozen-lockfile ..."
  if ! (cd "$repo" && pnpm install --frozen-lockfile); then
    sentry_fail "pnpm install failed."
    return 1
  fi

  sentry_section "[8/12] Repository build"
  echo "  pnpm build ..."
  if ! (cd "$repo" && pnpm build); then
    sentry_fail "pnpm build failed."
    return 1
  fi
  if [ ! -f "$repo/apps/desktop/dist/main/index.js" ] || [ ! -f "$repo/apps/desktop/dist/preload/preload.js" ] || [ ! -f "$repo/apps/desktop/dist/renderer/index.html" ]; then
    sentry_fail "Desktop build output is incomplete. Run: pnpm --filter @qa/desktop build"
    return 1
  fi
  sentry_ok "Dependencies installed; Desktop built"

  sentry_section "[9/12] Native runtime"
  local deploy_version="${version}-${sha}"
  local prev_current="$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)"
  if ! sentry_runtime_deploy "$repo" "$deploy_version"; then return 1; fi

  sentry_section "[10/12] Runtime verification"
  local entry="$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
  local hello_line=""
  hello_line=$(sentry_verify_runtime "$entry" "$node_bin" "$repo") || {
    printf '%s\n' "$hello_line"
    if [ "$prev_current" != "NONE" ]; then
      ln -sfn "$prev_current" "$HOME/.local/share/sentry/runtime/current"
      echo "  Rolled runtime/current back to $prev_current."
    fi
    sentry_fail "Runtime verification failed (previous runtime preserved)."
    return 1
  }
  printf '%s\n' "$hello_line"
  sentry_ok "Runtime handshake passed"

  sentry_section "[11/12] Agent tools"
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
    sentry_ok "Claude Code $pinned_cc (Sentry-managed native Linux)"
    if [ -n "$managed_cc" ] && [ "$managed_cc" != "missing" ]; then sentry_desktop_persist_binary "$repo" SENTRY_GLM_BINARY "$managed_cc" || true; fi
    cc_ready=1
  elif printf '%s\n' "$cl_out" | grep -q 'PATH_OK' && printf '%s\n' "$cl_out" | grep -q 'PATH_NATIVE=linux'; then
    local reuse_cc="$(printf '%s\n' "$cl_out" | sed -n 's/^PATH_CLAUDE=//p' | head -n 1)"
    sentry_ok "Claude Code $pinned_cc (reusing existing native install; global untouched)"
    if [ -n "$reuse_cc" ] && [ "$reuse_cc" != "MISSING" ]; then sentry_desktop_persist_binary "$repo" SENTRY_GLM_BINARY "$reuse_cc" || true; fi
    cc_ready=1
  else
    echo "  Installing Sentry-managed Claude Code $pinned_cc (local npm prefix only)..."
    if bash "$linux_dir/install-claude.sh" "$pinned_cc" 2>&1 | tail -n 2; then
      sentry_ok "Claude Code $pinned_cc (Sentry-managed)"
      cc_ready=1
    else
      sentry_warn "Claude Code could not be installed automatically."
    fi
  fi

  sentry_section "[12/12] Launcher"
  sentry_install_shim "$repo"
  sentry_config_set SENTRY_NODE_BINARY "$node_bin"
  sentry_config_set SENTRY_REPO_PATH "$repo"
  sentry_config_set SENTRY_SETUP_VERSION "$version"
  sentry_config_set SENTRY_SETUP_COMMIT "$sha"
  local glm_ready=0
  if [ "$cc_ready" = "1" ] && [ "$sandbox_ready" = "1" ]; then glm_ready=1; fi
  echo ""
  echo "Sentry v0.1 Beta Setup (CachyOS)"
  echo "========================================"
  echo "Host"
  sentry_ok "CachyOS ($(sentry_os_pretty))"
  sentry_ok "Node $node_bin"
  echo "Sentry"
  sentry_ok "Dependencies installed"
  sentry_ok "Desktop built"
  sentry_ok "Runtime deployed"
  sentry_ok "Runtime handshake passed"
  sentry_ok "sentry command installed"
  echo "========================================"
  if [ "$oc_ready" = "1" ] && [ "$ds_ready" = "1" ] && [ "$glm_ready" = "1" ]; then
    echo "Sentry is ready."
    echo "Run: sentry open"
    echo "Then configure provider accounts in: Settings -> Providers"
    return 0
  fi
  echo "Sentry core setup completed."
  echo "Full 3-agent QA is NOT ready; affected runs stay unavailable until the tool is installed."
  echo "Run:"
  echo "    sentry doctor"
  return 2
}

