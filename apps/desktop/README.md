# Sentry Desktop (Phase 8)

Local desktop QA workspace built on the frozen Stable Core.

- Electron main owns Sentry (DB, repository, lease, ProjectManager, RunCoordinator).
- Renderer is presentation only: no Node access, no direct SQLite.
- Typed IPC via preload window.sentry (validated with Zod in main).
- Live updates poll persisted truth (500 ms active / 5 s idle).
- Simulation only during Phase 8 development: no paid provider calls.

## Develop

Run the renderer dev server, then Electron against it:

    pnpm --filter @qa/desktop dev
    SENTRY_DESKTOP_URL=http://127.0.0.1:5174 pnpm --filter @qa/desktop dev:electron

Seed deterministic simulation fixtures with SENTRY_DATA_ROOT set (FULL + TARGETED +
merge + verify + issues + PARTIAL + revision B + retest; no paid providers):

    pnpm --filter @qa/desktop seed

## Gates

    pnpm --filter @qa/desktop typecheck
    pnpm --filter @qa/desktop lint
    pnpm --filter @qa/desktop test
    pnpm --filter @qa/desktop build

Packaging and distribution are explicitly Phase 9 (development-grade only).
