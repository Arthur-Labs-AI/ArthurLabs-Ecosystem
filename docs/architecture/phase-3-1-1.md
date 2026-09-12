# Phase 3.1.1 -- Live Integration Trust Hardening

Status: COMPLETE (deterministic gates green, exact-HEAD CI green, final WSL live regression PASSED)

Baseline: b65bb5d0e7c38879e1f56c146645f6c35306eda0 (Phase 3.1 complete, live smoke PASSED).
Phase 3.1 stays intact and its historical smoke remains valid evidence. This is a small hardening pass over the live Muse integration only. No DeepSeek, GLM, multi-agent execution, merger, verifier, retest, UI, or adaptive InvestigationDepth.

## Approval decider is fail-closed

- Explicit subject-kind allowlist: shell, fileAccess, process, tool. Unknown kinds (the MSP union is open) are denied; safety is never inferred.
- Positive containment proof required: shell/process/tool subjects must carry a subject workspaceRoot that canonicalizes inside the Sentry workspace; missing proof denies. fileAccess additionally requires its target path (path or target field) to resolve inside the workspace.
- Canonicalization (canonicalizeApprovalPath + realpath where present) defeats .. escapes, sibling-prefix confusion (/work/project2 vs /work/project), and symlink escapes; Windows case-insensitivity preserved.
- Network (kind or host/port/protocol), protectedWrite, and judgeEscalated always deny.
- Choice semantics, not label regex: approval requires decision approved with scope once. Session-persistent and policy-amending approvals are never chosen, so QA cannot mutate the user persistent Muse policy. Denial uses a server-offered abort (or once-scoped denial); choice IDs are never invented, and refusal without a safe choice throws loudly with the turn watchdog as last net.
- Approval mode is onRequest (least authority): every tool request routes to Sentry explicit decider. Sandbox enforcement is orthogonal and stays host-enforced in every mode. No --yolo, no sandbox-disable flags.
- Every decision is observable: per-item drain plus a final end-of-turn drain emit MUSE_APPROVAL_GRANTED/DENIED warnings, so a last-item decision cannot vanish.

## Command evidence integrity

- The observed operation is authoritative: operation-linked command evidence derives command, exitCode, and durationMs from the ObservedOperation, never from model text.
- Text mismatch policy (deterministic): reproduced claims rejected as misrepresentation; weaker claims downgrade to manual/agent_reasoning. Exit-code alteration on a matched operation is always fatal (spoofing).
- Without an operation link, strict string identity still applies with the same downgrade/reject split.

## Structured-output contract consistency

- describeSentryAgentEvidenceContract() in @qa/schemas derives the evidence field contract from the Zod source (fields enumerated, enums read off the schema unions). The Muse prompt renders it instead of a hand-maintained blob.
- A consistency test fails if parser and prompt drift: every parser field must appear in the description.

## Live regression gate

- The live smoke now requires details.run.status completed, sole AgentRun completed, a run.completed event, and no run.failed. Zero findings stay allowed; tautological assertions removed.
- Watchdog taxonomy kept stable (MUSE_START_FAILED, phase-named message, retryable) for CLI contract compatibility. Coordinator integration proves disposal, workspace cleanup, lock release, and partial-event persistence after timeouts.

## Compatibility honesty

- runtimeIdentity.modelId means requested/configured through Muse, never proven provider-level execution identity.
- The adapter captures handshake canary facts (server name/version, MSP schema fingerprint/version, granted capabilities, platform) without coupling Core to Muse protocol details. Non-1 envelope schema versions warn (MUSE_SCHEMA_MISMATCH) instead of being silently assumed.

## Final live regression (WSL2 Ubuntu prepared host, Muse 1.1.1)

LIVE MUSE SMOKE TEST PASSED
- Muse executable: Muse Code 1.1.1 (1.1.1-R2514.1); SDK 0.1.1; model muse-spark-1.3-contributor
- Run run_01M2BSBFJJA2MXYHV1Z9RJ4F6E: status completed; agent completed, no failure
- 1 plan; 12 tool operations; usage turns 2
- 6 evidence: 4 code_reference/strong_code_evidence/baseline, 1 runtime/reproduced_failure, 1 log/tool_diagnostic
- 2 findings: confirmed/logic (real divide-by-zero defect) plus strong/testing (honest toolchain limitation)
- Workspace cleaned; fixture and baseline hashes match; json + log exports produced
- No fake labels, no FakeHarnessAdapter, no persisted reasoning, no credentials printed

## Deferred (explicitly not in 3.1.1)

DeepSeek, GLM, parallel agents, merger, verifier, retest execution, UI, adaptive InvestigationDepth, token budgets -- untouched. FakeHarnessAdapter stays test-only.
