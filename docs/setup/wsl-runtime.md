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

## 3b. Project import exclusions (hash v2)

- Project import/update applies the default import exclusion set before
  copy+scan: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.turbo`,
  `.pnpm-store`, `.sentry-live`, `.tmp-sentry-test-fixtures`, `.ai-harness`,
  `.superharness`, `.DS_Store`, `*.log` (matched at any depth, case-aware).
- New revisions record `hashVersion: 2`; legacy full-tree revisions are v1.
  Retest refuses cross-version A→B comparison (`RETEST_HASH_VERSION_MISMATCH`).
- Opt out (full-tree v1 import) only for exotic layouts:
  `SENTRY_IMPORT_INCLUDE_ALL=1` in the runtime environment.
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

## 7. GLM Claude Code Bash sandbox gate (mount isolation architecture)

Green CI does NOT prove GLM Bash works: the live smoke below runs in the SAME
WSL environment Desktop Sentry uses (Windows Electron → wsl.exe → Sentry
runtime → systemd-isolated Claude worker → real Claude Code binary → real
bubblewrap → real Bash). A mocked child process or plain Linux CI runner is
not equivalent.

Sentry isolates Claude from Windows mounts. On WSL workers every Claude
turn spawns inside a transient systemd user unit whose mount namespace
shadows `/mnt/c` with an empty tmpfs (`TemporaryFileSystem=/mnt/c`).
Claude's unconditional Windows-profile enumeration therefore finds nothing,
so stale or ACL-blocked host profiles (e.g. `CodexSandboxOffline`) cannot
affect the run. The host profiles are not part of the Claude QA runtime —
no ACL repair, account deletion, or `.claude` seeding is ever required.
The rest of Sentry (project import, runtime, other harnesses) keeps normal
`/mnt/c` access; only the Claude worker is isolated. Claude's own inner
bubblewrap sandbox and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` remain fully
enforced inside the outer namespace.

From a Linux checkout with dependencies installed (replace Ubuntu if your
distro differs):

```bash
SENTRY_LIVE_CLAUDE=1 ./node_modules/.bin/vitest run tests/claude-live.test.ts
```

Expected: all smoke tests pass, including `sentry-wsl-isolation-ok` (nested
bwrap Bash exit 0 with no `/mnt/c` profile names in Claude Bash output),
cancel/loop-breaker/init-timeout unit cleanup, and planning completion.
Terminal event is `run.completed` (never `GLM_SANDBOX_UNAVAILABLE` or
`GLM_CLAUDE_VERSION_UNSUPPORTED`).

Version policy (data-driven): the adapter runs fail-closed on live-proven
incompatible Claude Code versions (currently 2.1.276) with
`GLM_CLAUDE_VERSION_UNSUPPORTED`; unknown newer versions warn
(`GLM_CLAUDE_VERSION_UNVERIFIED`) and continue. Validated version: 2.1.270
(`SENTRY_CLAUDE_BINARY` selects the binary; preflight fails closed with
`GLM_CLAUDE_RUNTIME_MISMATCH` if a Linux/WSL process would launch a
Windows-mounted executable or shim).

Windows-profile troubleshooting (fallback information only):
Claude Code binds every enumerated `/mnt/c/Users/*/.claude/ide` into
bubblewrap unconditionally (its `RPe()` IDE path list — no settings/env
gate; independent of Sentry's ephemeral HOME). With mount isolation
healthy this is invisible to Claude and needs no action. If isolation is
unavailable, `qa agent doctor glm` reports a failing `wsl-isolation`
check plus a `wsl-profiles` check naming the profiles that would block a
direct launch — treat that as an isolation outage, not a request to
repair host ACLs.

Safe diagnostics (names/paths only, never secret values):
`qa agent doctor glm` reports the resolved executable, realpath, version,
platform/WSL facts, effective HOME/CLAUDE_CONFIG_DIR, stripped Windows
profile / IDE-bridge inputs, mount-isolation status (`wsl-isolation`),
and host profile state (`wsl-profiles`, informational while isolated).

- Opening Environment never spends provider budget; only FULL/TARGETED/RETEST start paid runs.
