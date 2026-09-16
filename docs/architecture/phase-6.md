# Phase 6 — Independent Evidence-First Verifier

## Purpose and trust boundary

The Verifier consumes a persisted Phase 5 MergeResult and checks each
FindingCluster independently against the exact ProjectSnapshot used by its QA
run. Fresh observations, not agent agreement, determine the outcome. Muse,
DeepSeek, GLM, and Merger v2 are frozen; verification never reruns QA agents or
uses an LLM judge. `inconclusive` is an honest first-class outcome.

## Current architecture (Phase 6.1.1)

### Historical material and disposable workspaces

New project revisions commit only after immutable revision material has been
retained and hash-validated. Retention failure rolls the update back. The
Verifier validates retained material again before staging a fresh workspace
for each cluster. Staging is outside the Sentry data root, so the whole data
root can be blocked inside the sandbox. A historical revision A remains
verifiable after the managed project advances to B. Pre-retention revisions
without valid material fail honestly as `inconclusive`, never by substituting
the current working copy.

### Sandbox and process ownership

`VerificationSandboxBackend` is the execution boundary for runtime replay.
On supported Linux hosts the systemd user-service backend preflights actual
mount isolation and launches a distinct transient unit for each command.
An empty root filesystem exposes only read-only system/toolchain directories
and explicitly bound verifier workspace/HOME/tmp paths. `ProtectHome=yes`
and a private network reinforce this boundary; the unbound Sentry data root,
real HOME, host `/tmp`, and peer workspaces are invisible.
The verifier
uses an allowlisted environment and shell-less, bounded argv execution.
Recorded path/shell checks are additional defenses, not the isolation
boundary. If the backend or its preflight is unavailable, runtime replay is
unsupported and verification fails closed; it never falls back to host
execution. `qa verify doctor` reports backend availability without a paid
agent run. Windows has no runtime-replay backend; run under a supported Linux
environment (including a compatible WSL2 systemd user session).

The transient unit owns the full replay process tree. Timeout and disposal
stop that unit, then clean only verifier-owned staging. No global process
kills are used. Each cluster receives exactly one durable attempt ID before
fallible work; normal errors and unexpected crashes terminalize that same
attempt. Stale running verification rows are recovered on coordinator
startup, not by a background lease sweeper.

### Deterministic recipe and replay

`buildRecipe` derives steps from canonical persisted evidence and grounded
`command.executed`/`test.result` operations, never prose. Natural-language
reproduction steps are non-executable context. Supported steps include
source integrity, command replay, test replay, and unsupported claims.
Commands replay from their recorded `cwdRelative`, resolved beneath the
fresh workspace with traversal, symlink-escape, missing-directory and
non-directory checks. Missing tools, unsupported shell syntax, browser-only
claims, and unavailable sandbox capabilities remain `unsupported`, not
synthetic mismatches.

### Observation and outcomes

Framework-aware test identity requires the exact target or a valid `.`,
`::`, or `/` descendant boundary; substring matches do not count. An
unobserved target yields only a weak exit observation and forces the attempt
to `inconclusive`, even when other steps match. An observed
target passing when failure was expected is a strong mismatch. Command
replay uses a strong match or mismatch only when canonical original evidence
supports a decisive comparison; exit-code-only observations are weak.
`reproduced` requires a strong positive runtime observation, while
`not_reproducible` requires a strong negative observation with no unresolved
required steps. Weak, blocked, timed-out, or unsupported evidence yields
`inconclusive` unless another supported outcome is justified. Source
integrity alone cannot establish runtime reproduction.

### Versioned signatures and persistence

`VERIFIER_VERSION`, `VERIFICATION_RECIPE_VERSION`, and
`VERIFICATION_SIGNATURE_VERSION` are all 3. `sig3` hashes the full normalized,
redacted diagnostic content; its short preview is display-only and never an
equality key. The prefix-collision fixture guards against treating equal
previews as equal diagnostics. Versioned v1/v2 records remain readable and
are not reinterpreted as v3 evidence.

The additive verification tables retain runs, ownership-immutable attempts,
steps, insert-only observations, and assertions. Step observations and
terminal outcomes are persisted incrementally. QARuns, MergeResults,
Findings, and original Evidence are never mutated by verification.

### CLI and scope boundary

The v1 CLI contract remains intact. `qa verify start` and `qa verify show`
remain explicit operations; `qa verify doctor` is additive. JSON and log
exports expose verification records while keeping large replay output in
the artifact store. No Phase 7 retest UX, fix-state tracking, or UI is part
of Phase 6.1.1. Browser/external-service and prose-only claims remain
inconclusive unless separately supported by canonical evidence.

## Historical note

Phase 6 initially used v1 signatures and current-revision-only material.
Phase 6.1 introduced v2 identity, redaction, process cleanup, and initial
retention. Those descriptions are historical; the v3 architecture above is
the current contract. Old records retain their original version semantics.
