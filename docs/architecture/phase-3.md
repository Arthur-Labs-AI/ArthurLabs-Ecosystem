# Phase 3 — Real AgentStack execution foundation

Status: **IMPLEMENTED LOCALLY — LIVE MUSE SMOKE AND GITHUB ACTIONS STATUS RECORDED AT RELEASE TIME**

Phase 3 adds the first production agent path: one Muse Code worker performs a
full QA investigation in an isolated writable copy. Fake simulation remains a
development/test capability and is not used by `qa run start`.

## Execution flow

1. `qa run start` resolves the Muse registration and preflights the exact model
   configuration and executable.
2. The existing project manager verifies the managed copy and freezes a content
   snapshot.
3. The workspace factory creates one private writable workspace for one
   AgentRun.
4. `MuseHarnessAdapter` starts `muse serve` through `@muse-code/sdk@0.1.1`, with
   no shell command string and no sandbox-disable flags.
5. In one Muse session, the first turn returns a strict plan. Sentry mints its ID
   and persists it before allowing the second turn.
6. The execution turn emits observable tool events and a strict result.
   Sentry validates path containment and references, then mints and persists
   hypotheses, evidence, and findings.
7. The adapter emits reported token usage and a terminal event. The coordinator
   confirms shutdown before workspace cleanup and writes log/JSON exports.

No model reasoning is persisted. No peer agent, subagent fanout, merger,
verifier, retest, automatic fix, or source-project mutation is part of this
phase. A Muse attempt to emit a subagent-like item fails closed.

The mission includes sanitized project/revision/snapshot/context metadata, the
frozen run instructions, QA policy, and stack definition. It excludes the
original source path and all peer data. The policy requires comprehensive
applicable checks, permits investigative edits only in the disposable workspace,
forbids product fixes and Git publication, and records blocked checks as
limitations.

## Runtime identity

New AgentRuns persist the selected model, adapter/version, exact SDK version,
resolved executable command, detected executable version, and Muse host version
when each value is available. Missing observations remain absent, never zero or
guessed. Secrets are neither runtime identity nor result data.

## CLI

```text
qa agent list [--json]
qa agent doctor muse [--json]
qa run start <project-id> --mode full --agents muse --wait [--instructions <text>] [--timeout-ms <ms>] [--json]
```

`run start` is deliberately blocking in Phase 3; `--wait` is required. Human
output labels it `REAL MUSE QA RUN`; JSON returns `"simulated": false`.
`run show`, `run status`, and `run export` accept both simulation and production
runs. Production JSON exports use `sentry.agent-run`.

## Safety and failure semantics

- Muse can read/write only its Sentry-created workspace by session contract.
- Lexical traversal and symlink escapes in returned evidence are rejected.
- Approval is non-interactive while Muse sandboxing remains enabled by default.
- Startup, authentication, sandbox, invalid-result, subagent, timeout,
  cancellation, and transport failures are structured and bounded.
- `client.close()` is idempotent and bounded. On Windows, the SDK only guarantees
  child termination, not descendant process-tree termination.
- The original source and managed working copy remain unchanged by the agent.

## Test policy

Normal CI uses an injected deterministic SDK facade and never requires a Muse
binary, credentials, model network access, or paid call. A credentialed live
smoke is opt-in with `SENTRY_LIVE_MUSE_TEST=1`; when the binary/model/credentials
are unavailable, release reporting states **NOT RUN** with the concrete reason.

See [ADR-0012](../adr/0012-muse-code-sdk-adapter-boundary.md) and the
[Muse setup guide](../setup/muse-code.md).
