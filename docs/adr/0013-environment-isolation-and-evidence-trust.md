# ADR-0013: Autonomous agent environment isolation and evidence trust

Status: accepted

## Context

Phase 3 gave Sentry its first real autonomous QA worker (Muse via
muse-code-sdk). Two gaps blocked trusting the same execution architecture
for additional providers: the worker inherited the whole Sentry process
environment, and model-generated JSON claims could become durable proof
without independent observation.

## Decision

1. Autonomous QA workers receive only explicitly allowed host environment
   state. The harness builds a sanitized child environment (OS runtime,
   temp dirs, locale, and explicitly allowed agent configuration); unrelated
   secrets are never forwarded. Redaction stays as a second layer, not the
   primary control. Only variable names and inclusion decisions are ever
   reported; values and credentials are never persisted.

2. Model-generated claims are not automatically considered observed evidence.
   Production findings require referenced durable evidence; confirmed
   findings require grounded evidence (reproduced behavior/failure, tool
   diagnostics, strong code evidence, or correlated command/test/code
   artifacts). Test, runtime, and log claims without observed tool activity
   are downgraded or reclassified, never silently trusted. File evidence
   carries accurate baseline vs modified_workspace provenance by comparing
   workspace hashes against the immutable run snapshot.

3. These rules are generic (Sentry core + schemas) so every future agent
   inherits them; only tool-operation correlation is vendor-specific and
   lives in the owning harness adapter.

## Consequences

- DeepSeek and GLM adapters reuse the same trust contract without
  re-deriving it.
- Live validation (opt-in SENTRY_LIVE_MUSE_TEST=1) must demonstrate the full
  pipeline on a real host before the architecture is declared ready to
  replicate.
- Readiness reporting distinguishes configured from live-verified; doctor
  stays cheap and honest about what it has not proven.
