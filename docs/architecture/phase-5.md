# Phase 5 — Deterministic Finding Merger & Agreement Layer

## Purpose

Deterministically normalize, compare, cluster, and present equivalent
findings from independent AgentStacks WITHOUT inventing consensus and
WITHOUT using another AI model. The Merger answers which independently
produced findings describe the same underlying issue, which agents
support it, and where reports agree or differ. It is NOT a verifier
and does not decide whether a bug is true.

## Agent freedom (canonical product principle)

> Every Sentry QA AgentStack operates independently against its own
> disposable writable project workspace and may use the capabilities
> required to perform high-quality QA inside that environment. Sentry
> protects the original project, managed baseline, peer workspaces and
> host boundaries; it does not intentionally cripple investigative
> capability inside the agent's own QA copy.

Phase 5 adds no tool restrictions. Containment stays around the
environment, not inside the agent's QA copy.

## Inputs

Canonical persisted Sentry data only: QARun, usable AgentRuns,
canonical Findings/Evidence, runtime identities, AgentStackIds. Never
raw reasoning, transcripts, provider state, peer prompts, or
workspaces. All compared findings must share one QARun and one
ProjectSnapshot (fail closed otherwise). Partial runs are valid input
with honest expected/usable/unavailable counts.

## Normalization (normalizer v1)

Findings become NormalizedFinding records: normalized title atoms,
category/severity/confidence, NFC + ASCII-folded token sets (fixed
versioned stop words), normalized paths/symbols/line ranges, behavior
and root-cause tokens, evidence fingerprints (paths, line ranges,
hashes, command characteristics — never cross-run OperationIds),
canonical sort keys. Originals are never mutated.

## Equivalence rules (merger v1)

Explainable features: same file, same symbol, line overlap/nearness,
category compatibility (small versioned families, never a veto),
title/behavior similarity (Jaccard + subset + shared-topic signals),
evidence fingerprint overlap. Conservative rule: a strong anchor
(same symbol, overlapping lines, or shared evidence on the same file)
PLUS corroboration. Same file alone, title alone, or category alone
never merges. Category disagreement is recorded, not punished.

## Clustering

Complete-link compatibility: a finding joins a cluster only when
equivalent to EVERY existing member (no transitive chain-merging).
Stable finding-ID insertion order makes output order-invariant.
Duplicate findings from one agent may cluster but count as ONE
supporting agent. Silence is `not_reported`, never contradiction.

## Agreement semantics

- `single_source`: one unique supporting agent.
- `multi_source`: more than one, but not all usable agents.
- `all_available_sources`: every usable AgentRun reported equivalently
  (with expected/usable counts so a 2/2 usable + 1 failed agent never
  reads as 3-agent unanimity).

Agreement never upgrades confidence; severity/confidence aggregate as
preserved value lists plus exact/disputed flags. Field disagreements
(severity, confidence, category, location, rootCause) record
per-agent values without majority rewriting.

## Representative selection (documented rule)

Strongest canonical grounding present, then highest severity, then
highest confidence, then smallest FindingId. Agreement count never
boosts anything.

## Identity and idempotency

Cluster IDs are deterministic (`cluster_` + hash of merger version,
snapshot, and sorted finding IDs). `inputDigest` covers merger
version, run, snapshot, and sorted source IDs; re-merging unchanged
input reuses the persisted MergeResult (no duplicate rows).
MergeResults are immutable; algorithm changes bump `mergerVersion` and
create new rows. Merge failure never changes QARun status.

## Persistence

Additive migration (v3): `merge_results` (unique run+digest),
`finding_clusters`, `finding_cluster_members`, `cluster_evidence`,
`cluster_disagreements` — all with foreign keys, ownership-immutability
triggers, and deterministic read order. Compute happens outside the
write lock; one short transaction persists everything or rolls back.
Source findings/evidence are never modified.

## CLI and exports

Explicit post-run operation only (never auto-run):
`qa run merge <run-id> [--json]` returns mergeResultId, reuse flag,
and counts (exit 3 run-not-found, 4 run-not-terminal, 6 nothing
usable). JSON export gains additive `mergeResults` +
`findingClusters` sections; log export renders cluster support,
unavailable agents, severity reports, and source references without
claiming disagreement from silence.

## Trust foundation

Provenance dominates strength: manual reasoning is always
`model_reported`; validated code references are `source_verified`;
operation backing requires durable `groundingOperationIds`.
ReportV2 rejects impossible strength/type combos at the schema
boundary. Cluster grounding summaries (`hasReproducedEvidence`,
`hasOperationEvidence`, `hasSourceEvidence`, `hasOnlyModelReasoning`)
describe existing evidence; they are not confidence scores.

## Future verifier boundary

MergeResult carries everything a verification mission needs:
clusters, source findings/evidence, locations, reproduction steps,
and disagreements. No transcripts required.
