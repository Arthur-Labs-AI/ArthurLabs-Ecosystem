# Changelog

All notable user-facing changes to Sentry are documented here.

## [0.1.0-beta.1] - 2026-09-26

The first public user-facing Beta: clone, one setup command, use.

### Added

- Sentry Desktop application (Electron + React): dashboard, projects,
  project work hub, run workspace with resizable panels and tabbed inspector.
- WSL2 execution runtime with isolated agent workspaces, evidence pipeline,
  and `runtime.hello` handshake verification.
- OpenCode agent (tested 1.18.32), DeepSeek agent (SDK 0.1.5-rc.2), GLM agent
  (adapter-tested Claude Code 2.1.270) running independently per snapshot.
- Full QA and Targeted QA; independent findings with rich per-agent detail,
  evidence, and JSON/log export with native Save As.
- Secure provider settings (Settings → Providers) via Electron safeStorage /
  Windows DPAPI.
- `sentry` Windows launcher: `setup`, `open`, `update`, `stop`, `status`,
  `doctor`, `version`, `help` with user-PATH shim and resumable setup.
- Beta docs (getting-started, troubleshooting, updating), release notes,
  bug-report template, and release checklist.

### Notes

- Windows 11 + WSL2 only for this Beta; source-based install.
- `sentry update` tracks latest `main` commits (not Releases) for now.
- No signed installer yet.
