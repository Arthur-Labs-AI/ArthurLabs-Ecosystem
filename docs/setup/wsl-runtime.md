# Sentry WSL2 Runtime Setup (developer/manual, Phase 8)

No secrets below — substitute your own values where indicated.

## 1. WSL2 + Ubuntu + systemd

- Install WSL2 with Ubuntu from an elevated PowerShell: `wsl --install -d Ubuntu`.
- Ensure WSL2 (not WSL1): `wsl --list --verbose` must show version 2.
- Ensure systemd is active inside the distro:
  `wsl -d Ubuntu -- systemctl --user show-environment` should succeed, and
  `wsl -d Ubuntu -- systemd-run --user --pipe --wait echo ok` should print `ok`.
- Do not edit `/etc/wsl.conf` automatically in Phase 8; enable systemd manually if needed.

## 2. Node + pnpm in WSL

- Node 22: `wsl -d Ubuntu -- node --version` (22.x expected).
- pnpm 9: `wsl -d Ubuntu -- pnpm --version` (install via `npm install -g pnpm@9` if missing).

## 3. Deploy the Sentry runtime

- From the repo on Windows (PowerShell):
  `powershell -ExecutionPolicy Bypass -File apps/runtime/scripts/deploy-wsl-runtime.ps1 -Distro Ubuntu`
- This copies the tree (excluding `node_modules`/`dist`/`.git`) into
  `~/.local/share/sentry/runtime/0.1.0`, installs Linux dependencies there, builds
  `@qa/runtime-protocol` + `@qa/runtime`, and links `.../runtime/current`.
- Verify: `wsl -d Ubuntu -- node ~/.local/share/sentry/runtime/current/apps/runtime/dist/host.js --help`
  (exits 2 with usage) and `... --stdio` + `runtime.hello` handshake over stdin.

## 4. Provider CLIs in the same distro

- DeepSeek: install the `dsh` harness so `wsl -d Ubuntu -- which dsh` resolves.
- Muse: install Muse Code in WSL and run `muse login` **inside that distro**
  (Windows login state does not transfer).
- GLM: install Claude Code in WSL (`which claude`), used with the trusted Z.AI endpoint.

## 5. Provider model configuration

- In Sentry Desktop: Settings → Providers. Save `SENTRY_DEEPSEEK_MODEL` (e.g.
  `deepseek-flash`), `SENTRY_GLM_MODEL` (e.g. `glm-5.3-flash`), `SENTRY_MUSE_MODEL` (e.g.
  `muse-spark-1.3-contributor`), plus `DEEPSEEK_API_KEY` / `ANTHROPIC_AUTH_TOKEN` and
  `ANTHROPIC_BASE_URL` as applicable.
- Desktop pushes them into runtime memory via `runtime.configure` (no restart needed).
- Secrets stay encrypted in Windows safeStorage; WSL keeps them memory-only.

## 6. Checking doctors

- Sentry Desktop → Environment shows the WSL runtime section (distro, Node, protocol,
  data root, systemd, verifier sandbox) plus per-stack Muse/DeepSeek/GLM readiness.
- CLI equivalent inside WSL: run the doctors from the deployed tree.
- Opening Environment never spends provider budget; only FULL/TARGETED/RETEST start paid runs.
