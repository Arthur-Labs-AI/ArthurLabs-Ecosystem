# ADR-0001: pnpm workspaces + Turborepo

Status: accepted

## Context

Phase 1 needs strict package boundaries (domain vs schemas vs protocol vs apps)
with fast, cached task orchestration.

## Decision

Use pnpm workspaces for linking and Turborepo for build/test/lint/typecheck
pipelines. Share toolchain versions through the pnpm catalog so TypeScript,
ESLint, Vitest, and Zod can never drift between packages.

## Consequences

Single `pnpm install`, hermetic per-package builds, remote-cache-ready tasks.
Cost: contributors need pnpm 9 + Node 22.
