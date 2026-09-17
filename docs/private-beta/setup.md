# Sentry Private Beta — Technical Setup

Sentry 0.7 is a CLI-oriented technical private beta. There is no installer,
no desktop UI, and no one-click provider setup yet (those arrive in
Phases 8–9). This document covers the full manual path from repository
clone to a first verified run.

## 1. Prerequisites

- Node.js ≥ 22 and pnpm 9.
- Git.
- A supported verifier runtime: direct Linux, or a Windows host with WSL2
  Ubuntu running a systemd user session (the verifier stages replay work
  under `/var/tmp` and uses systemd transient units). There is no native
  Windows runtime verifier — `qa verify doctor` reports honestly.
- Provider access for the agent stacks you intend to use:
  - Muse: installed `muse` CLI + `SENTRY_MUSE_MODEL` (intended:
    `muse-spark-1.3-contributor`). See `docs/setup/muse-code.md`.
  - DeepSeek: DeepSeek Harness binary + `SENTRY_DEEPSEEK_MODEL` +
    `DEEPSEEK_API_KEY`.
  - GLM: Claude Code binary + Z.AI configuration.

Sentry is software-type agnostic: it never requires .NET, Python, Java,
Node, or Docker globally. Project doctor reports only what looks applicable
to each project.

## 2. Clone, install, build

```sh
git clone <sentry-repo-url> && cd Sentry
pnpm install
pnpm build
```

The CLI is `apps/cli`: run it via the built entry or link it as `qa`.

## 3. Configure providers

Providers are configured through environment variables and the existing
harness binaries — never stored in the Sentry database. Verify each stack
truthfully (no silent fallback between stacks):

```sh
qa agent list --json
qa agent doctor muse --json
qa agent doctor deepseek --json
qa agent doctor glm --json
```

Unavailable stacks report `unavailable`; Sentry never substitutes another
model behind your back.

## 4. Check verifier readiness

```sh
qa verify doctor --json
```

Expect `sandboxAvailable: true` and `runtimeReplaySupported: true` on a
supported Linux/WSL2 host. If unavailable, verification outcomes stay
`inconclusive` — Sentry fails closed rather than weakening trust checks.

## 5. Add the first project

```sh
qa project add /path/to/project --json
qa project show <project-id> --json
```

Sentry imports the source into a managed copy and freezes an immutable
`ProjectRevision`. Your original source tree is never modified by QA.

## 6. Run FULL QA

```sh
qa run start <project-id> --mode full --wait --json
```

Defaults to all three agent stacks; narrow with
`--agents muse,glm` when needed. Then:

```sh
qa run merge <run-id> --json
qa verify start <merge-result-id> --json
```

## 7. Run TARGETED QA

```sh
qa run start <project-id> --mode targeted --paths src/auth,src/middleware --wait --json
qa run start <project-id> --mode targeted --paths src/payments \
  --instructions "Focus on token refresh and expired-token handling" --wait --json
```

Target paths must be project-relative and exist in the frozen snapshot.
See `docs/private-beta/quickstart.md` for the short path.

## 8. Update the project and retest

After fixing the source:

```sh
qa project update <project-id> --json
qa project revisions <project-id> --json
qa issue list <project-id> --json
qa issue ingest <merge-result-id> --json   # first occurrence per cluster (idempotent)
qa retest start <issue-id> --wait --json   # freezes the new revision, re-runs, assesses
qa retest show <retest-run-id> --json
qa issue history <issue-id> --json
```

Retest defaults to the current ready revision (`--revision <revision-id>`
overrides) and to all three agents (`--agents muse,glm` narrows). Verdicts
are `fixed`, `still_reproducible`, `partially_fixed`, or `inconclusive` —
never inferred from agent silence.

## 9. Where data lives

One data root (see `qa doctor` output): SQLite history plus managed
artifacts. History is retained until explicit `qa project delete
<project-id> --yes`. Back up by stopping Sentry and copying the data root;
there are no hot-backup guarantees in the private beta.

## 10. Diagnose failures

- `qa run status <run-id>`, `qa run show <run-id>`
- `qa verify show <verification-run-id>`
- `qa run cancel <run-id>` for a stuck nonterminal run (completed outputs
  are preserved)
- `docs/private-beta/troubleshooting.md` for common failures
