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
  echo "Sentry v1.0.0 Setup (product $version, CachyOS)"
  sentry_desktop_ensure_stopped "$repo" || return 1

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
  local missing_pkgs="$(sentry_cachyos_missing "${SENTRY_CACHYOS_CAPABILITIES[@]}")"
  if [ -n "$missing_pkgs" ]; then
    echo "  Installing missing CachyOS packages (pacman only, nothing removed)..."
    # shellcheck disable=SC2086
    if ! sentry_cachyos_install $missing_pkgs; then return 1; fi
    missing_pkgs="$(sentry_cachyos_missing "${SENTRY_CACHYOS_CAPABILITIES[@]}")"
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
  # Node's directory leads PATH for this process so pinned tooling with
  # `#!/usr/bin/env node` shebangs (pnpm, agent installers) resolves it.
  export PATH="$(dirname "$node_bin"):$PATH"

  sentry_section "[5/12] pnpm"
  local pnpm_line=""
  pnpm_line=$(sentry_ensure_pnpm "$repo") || { printf '%s\n' "$pnpm_line"; return 1; }
  printf '%s\n' "$pnpm_line"
  local pnpm_bin="$(printf '%s\n' "$pnpm_line" | sed -n 's/^PNPM_RESOLVED=//p' | head -n 1)"
  if [ -z "$pnpm_bin" ]; then sentry_fail "pnpm resolution produced no executable."; return 1; fi
  sentry_config_set SENTRY_PNPM_BINARY "$pnpm_bin"

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
  if ! sentry_pnpm_install "$repo" "$pnpm_bin"; then return 1; fi

  sentry_section "[8/12] Repository build"
  if ! sentry_pnpm_build "$repo" "$pnpm_bin"; then return 1; fi
  if [ ! -f "$repo/apps/desktop/dist/main/index.js" ] || [ ! -f "$repo/apps/desktop/dist/preload/preload.js" ] || [ ! -f "$repo/apps/desktop/dist/renderer/index.html" ]; then
    sentry_fail "Desktop build output is incomplete. Run: pnpm --filter @qa/desktop build"
    return 1
  fi
  sentry_ok "Dependencies installed; Desktop built"
  if ! sentry_ensure_electron "$repo" "$pnpm_bin"; then return 1; fi

  sentry_section "[9/12] Native runtime"
  local deploy_version="${version}-${sha}"
  local prev_current="NONE"
  prev_current=$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)
  if ! sentry_runtime_deploy "$repo" "$deploy_version" "$pnpm_bin"; then return 1; fi

  sentry_section "[10/12] Runtime verification"
  local entry="$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
  local hello_line=""
  hello_line=$(sentry_verify_runtime "$entry" "$node_bin" "$repo") || {
    printf '%s\n' "$hello_line"
    sentry_rollback_runtime "$prev_current"
    sentry_fail "Runtime verification failed (previous state preserved)."
    return 1
  }
  printf '%s\n' "$hello_line"
  sentry_ok "Runtime handshake passed"

  sentry_section "[11/12] Agent tools"
  local agents_out=""
  agents_out=$(sentry_provision_agents "$repo") || { printf '%s\n' "$agents_out"; return 1; }
  printf '%s\n' "$agents_out"
  local oc_ready="$(printf '%s\n' "$agents_out" | sed -n 's/^AGENTS_OPENCODE=//p' | head -n 1)"
  local ds_ready="$(printf '%s\n' "$agents_out" | sed -n 's/^AGENTS_DEEPSEEK=//p' | head -n 1)"
  local cc_ready="$(printf '%s\n' "$agents_out" | sed -n 's/^AGENTS_CLAUDE=//p' | head -n 1)"

  sentry_section "[12/12] Launcher"
  sentry_install_shim "$repo"
  sentry_config_set SENTRY_NODE_BINARY "$node_bin"
  sentry_config_set SENTRY_PNPM_BINARY "$pnpm_bin"
  sentry_config_set SENTRY_REPO_PATH "$repo"
  sentry_config_set SENTRY_SETUP_VERSION "$version"
  sentry_config_set SENTRY_SETUP_COMMIT "$sha"
  local glm_ready=0
  if [ "$cc_ready" = "1" ] && [ "$sandbox_ready" = "1" ]; then glm_ready=1; fi
  echo ""
  echo "Sentry v1.0.0 Setup (CachyOS)"
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
