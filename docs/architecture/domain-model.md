# Domain Model

```text
Project
  │ sourcePath = user's real folder (never the writable QA workspace)
  ▼
ProjectSnapshot            # exact state used by a run (git state + manifest + contentHash)
  ▼
QARun                      # mode, status pipeline, snapshotted configuration
  │
  ├─► AgentRun × N        # one AgentStack × one task inside the QARun
  │     ├─► Finding       # ONE agent's claim (title, severity, confidence, locations…)
  │     └─► Evidence      # supporting material (command/runtime/browser/static/…)
  │                         large outputs referenced as ArtifactIds
  ▼
UnifiedIssue               # platform grouping: findingIds[] + evidenceIds[] (no embedding)
  ▼
VerificationAttempt        # independent check: verified | failed | inconclusive
  ▼
FixProposal                # changedFiles[] + validation checks (no application in Phase 1)
```

CICDPlan and Artifact orbit the graph: plans propose provider pipelines per
snapshot; artifacts store large/file outputs referenced by evidence and fixes.

## Entities

- **Project** (`schemaVersion: 1`) — id, name, sourcePath, created/updated/lastOpened timestamps,
  extensible metadata (git detection, languages, package/test/CI hints).
- **ProjectSnapshot** (`schemaVersion: 1`) — sourceState (branch/head/dirty counts),
  manifest of `SnapshotFileEntry` (relativePath + sha256 + sizeBytes + type), contentHash.
  All paths project-relative.
- **AgentStackDefinition** (`schemaVersion: 1`) — stable id + displayName, enabled,
  ModelDefinition (open provider/modelId strings), HarnessDefinition (open adapterId
  - expectedProtocolVersion), ExecutionRequirements, QAPolicyReference, optional limits.
- **QARunConfiguration** — agentStackIds[], verificationLevel, policy, optional
  executionProfileId and cost/duration caps. Snapshotted at run creation.
- **QARun** (`schemaVersion: 1`) — mode (quick/full/targeted/ci/verify/fix/cicd),
  15-state status pipeline (created → … → completed/partial/failed/cancelled),
  lifecycle timestamps, optional summary.
- **AgentRun** (`schemaVersion: 1`) — qaRunId + agentStackId + taskType, 7-state status, optional
  AgentRuntimeIdentity (exact model/harness/adapter/policy versions for traceability),
  failure, usage.
- **Finding** (`schemaVersion: 1`) — severity (critical/high/medium/low/info, documented
  semantics) separate from confidence (confirmed/strong/probable/speculative).
  Controlled 19-value category taxonomy; `other` requires categoryDetail.
- **Evidence** (`schemaVersion: 1`) — a strict discriminated union of command,
  runtime, browser, static-analysis, code-reference, test, log, and manual payloads,
  plus strength (`reproduced_failure` … `agent_reasoning`). A type cannot omit its
  payload or carry a different subtype's payload; heavy output uses ArtifactIds.
- **UnifiedIssue** (`schemaVersion: 1`) — findingIds[] + evidenceIds[] + status
  (confirmed/corroborated/probable/unverified/rejected). No full-object embedding.
- **VerificationAttempt** (`schemaVersion: 1`) — verified = independently reproduced;
  failed = evidence contradicts; inconclusive = undetermined.
- **FixProposal** (`schemaVersion: 1`) — changedFiles[] (rename requires
  previousRelativePath), patchArtifactId, build/tests/regression validation checks.
- **CICDPlan** (`schemaVersion: 1`) — provider (github_actions/…/custom), create|improve, recommendations
  - file proposals. No generation in Phase 1.
- **Artifact** (`schemaVersion: 1`) — type, relativeStoragePath (never absolute machine paths), mime,
  size, sha256.
- **AgentUsage** — optional tokens/cost/turns/duration; unknown stays `undefined`
  (zero means genuinely zero).

## Invariants

- Centralized opaque branded ID schemas; ULID-style `prefix_SUFFIX`; no auto-increment identity.
- ISO 8601 UTC strings for every serialized timestamp, including calendar validation.
- One shared `CodeLocationSchema` enforces relative paths and valid line ranges for
  Findings, static-analysis evidence, and code references.
- Relative paths only on transport; absolute Windows/Unix/UNC and `..` traversal rejected.
- `schemaVersion: 1` strict today; see ADR-0003 for migration principles.
- Pure transition helpers (`canTransition*`/`assert*`) govern QARun, AgentRun,
  VerificationAttempt, FixProposal — no framework.
