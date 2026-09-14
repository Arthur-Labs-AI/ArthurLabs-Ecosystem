# Phase 4.2 — Investigation / Reporting Separation

## Why this changed

Two-stage investigation/reporting caused repeated live serialization
failures because Sentry-owned operation identities were created during
the same turn in which the model had to cite them.

Phase 4.2 separates investigation from reporting and provides the frozen
post-investigation operation ledger to the final report turn.

## Three-stage lifecycle

```text
STAGE 1: PLANNING → immutable SentryInvestigationPlanV1
STAGE 2: INVESTIGATION (tools live here; terminal prose ignored)
STAGE 3: REPORTING (tool-free; frozen ledger; ReportV2; bounded repair)
```

All three stages run in the SAME logical model session per AgentRun
(Muse session, DeepSeek session id, Claude `--resume` chain). No
independent reporter agent; no peer leakage (own plan, own ledger, own
validation errors only).

## Frozen operation ledger

Built AFTER investigation terminates from the adapter-owned observed
operations (session-global, monotonic, never reset). Rendered by the
shared `renderFrozenLedger()` helper so the format is identical across
all three harnesses. The ledger is the ONLY authoritative source of
operation keys and exit codes; unknown stays unknown (never 0).

## Tool-free reporting

Reporting turns run with no tools. Harnesses without a native
empty-tools mechanism enforce an adapter-side firewall:
`MUSE_REPORT_TOOL_FORBIDDEN`, `DEEPSEEK_REPORT_TOOL_FORBIDDEN`,
`GLM_REPORT_TOOL_FORBIDDEN`. Any reporting-stage tool attempt fails the
report turn; the frozen ledger never mutates.

## SentryAgentReportV2

Model-facing report contract (`schemaVersion: 2`). Evidence is a
discriminated union keyed by `type`; each variant accepts only its own
fields (strict — cross-type bleed rejected by construction):

- `command`: key, description, strength, operationKey (REQUIRED).
  Sentry derives command/exitCode from the frozen operation.
- `test`: key, description, strength, operationKey (REQUIRED),
  framework?, name?. Sentry derives passed/failed from the observed
  exit code.
- `runtime` / `log`: operationKey optional, source (log) optional.
- `code_reference`: relativePath (+lines); no operation fields.
- `manual`: description only; nothing else.

Findings keep title, category, severity, confidence, description,
locations, evidenceKeys, reproductionSteps (required field, `[]`
allowed), plus optional behavior/root-cause/fix fields. V1
parsing/export compatibility is preserved for historical runs.

Single source of truth: prompts render `describeSentryAgentReportContract()`
from the Zod source; provider JSON Schema derives via the deterministic
walker `sentryAgentReportJsonSchema()`. CI consistency tests fail on
drift.

## Report-only repair

Initial report + at most one correction attempt (`MAX_REPORT_ATTEMPTS`).
Correction feedback is bounded structured validation errors; the model
re-emits the complete report in the same session with no tools and the
same frozen ledger. Investigation never reruns. Retry telemetry surfaces
as `*_REPORT_RETRY` warnings and actual turn counts in usage.

## GLM structured output

The report turn attempts `--json-schema` with the derived ReportV2
schema first. When the binary/route rejects the flag, the SAME report
retries without it under strict whole-document JSON (observable
`GLM_STRUCTURED_OUTPUT_UNSUPPORTED` warning). Sentry Zod validation
remains authoritative in both paths. Strict parsing is never relaxed:
no regex extraction, no prose stripping, no JSON repair.

## Token accounting

Usage aggregates actual model turns (planning + investigation + every
report attempt). Unknown stays unknown; no monetary costs. Phase
durations are not tracked; report-attempt counts provide the
model-quality telemetry future budgets need.

## Validation invariants (unchanged)

- Reproduced claims without verifiable operation proof fail.
- Known-code contradictions fail unconditionally.
- Ungrounded confirmed/strong findings fail.
- Unknown exit codes are never fabricated.
- No confidence auto-rewriting, no field dropping, no key invention.
