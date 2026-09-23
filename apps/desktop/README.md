# Sentry Desktop (Phase 8)

Local desktop QA workspace built on the frozen Stable Core.

- Electron main owns Sentry (DB, repository, lease, ProjectManager, RunCoordinator).
- Renderer is presentation only: no Node access, no direct SQLite.
- Typed IPC via preload window.sentry (validated with Zod in main).
- Live updates poll persisted truth (500 ms active / 5 s idle); renderer polling is a fallback.
- Production only: every new FULL, TARGETED, and RETEST run uses the configured OpenCode, DeepSeek, and GLM AgentStacks and consumes provider budget. No simulation mode exists.
- Provider credentials persist securely: Electron safeStorage-encrypted store under userData (no plaintext, no DB, no localStorage); secrets never return to the renderer. Without OS encryption, session-only with an explicit warning.
- Retest start is async: the desktop returns the RetestRun id immediately and the workspace goes live; assessment uses the frozen backend `result` field.
- Agent stage projection is evidence-driven with a Reporting stage (agent.message / usage.updated); pipeline nodes (Merger / Verifier / Issues) reflect actual artifact existence.
- Issue state is projected in main via frozen projectIssueState; the renderer never derives it.

## Test coverage

- Unit, component (jsdom), service integration (node), and smoke suites all run via `pnpm --filter @qa/desktop test` (vitest includes `src/**` + `tests/**`).
- True Electron smoke (`tests/electron`, Playwright) launches main → preload → renderer and asserts title, Dashboard, bridge presence, no Node integration, and navigation.

## Develop

Run the renderer dev server, then Electron against it:

    pnpm --filter @qa/desktop dev
    SENTRY_DESKTOP_URL=http://127.0.0.1:5174 pnpm --filter @qa/desktop dev:electron

## Gates

    pnpm --filter @qa/desktop typecheck
    pnpm --filter @qa/desktop lint
    pnpm --filter @qa/desktop test
    pnpm --filter @qa/desktop build

Packaging and distribution are explicitly Phase 9 (development-grade only).
