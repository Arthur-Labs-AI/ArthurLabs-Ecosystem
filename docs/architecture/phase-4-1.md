# Phase 4.1 — Parallel Validation Findings (diagnostic handoff)

Status: IN PROGRESS. All three stacks pass individually. The three-agent
parallel smoke has not yet completed: five parallel runs produced
`partial` with per-agent model-output rejections. The parallel machinery
itself (overlap, isolation, same snapshot, per-agent workspaces) is proven.
No Merger, no Verifier, no validation weakening.

## Proven working

- Muse individual smoke: PASSED (Phase 3.1.1).
- DeepSeek individual smoke: PASSED (`run_01M2DVW6BG7Y7BCXDHEB80QRSV`).
- GLM individual smoke: PASSED (`run_01M2EBSC5XCPEKTT8TH6DJREM3`).
- Parallel machinery: 100+ events per run with real overlap, per-agent
  failure isolation (no cascades), same immutable snapshot, separate
  workspaces, `partial` (never `failed`) whenever any agent produces
  usable output. Muse completed 3/3 parallel runs.
- Exact-HEAD CI: green on all implementation commits.

## Parallel run history

| Run       | Result  | Muse                      | DeepSeek                                        | GLM                         |
| --------- | ------- | ------------------------- | ----------------------------------------------- | --------------------------- |
| `...RW8T` | failed  | —                         | sandbox false-positive (our detector)           | —                           |
| `...S3RF` | partial | —                         | test-status label mismatch                      | —                           |
| `...SWJY` | partial | —                         | exit-code mismatch (our default-0 bug)          | —                           |
| `...TR53` | partial | —                         | op-link code mismatch (fixed by marker reading) | JSON prose                  |
| `...ECSQ` | failed  | reproduced mega-command   | `symbol` on evidence                            | JSON prose                  |
| `...EDS6` | partial | completed                 | exit-code mismatch (unknown codes)              | directory as evidence path  |
| `...FDHJ` | partial | completed                 | reproduced on codeless op                       | —                           |
| `...FKTD` | partial | completed                 | init timeout (transient)                        | overconfident `confirmed`   |
| `...FMWJ` | failed  | overconfident `confirmed` | reproduced on codeless op                       | missing `reproductionSteps` |

## Failure taxonomy (all correctly rejected — never validation bugs)

1. **Overconfident `confirmed`** (Muse, GLM, DeepSeek at various times):
   `confirmed` backed by manual/code-reference evidence only.
   Mitigation shipped: calibration line in DeepSeek + GLM prompts
   (Muse prompt deliberately untouched while passing; now needs it).
2. **Exit-code mismatches** (DeepSeek ×4): sub-cases found and fixed —
   our own default-0 fabrication, stripped markers, op-numbering
   restarts (fixed by ledger). Remaining: model cites codes for ops
   whose codes we genuinely never observed, or invents mega-commands.
3. **JSON shape non-compliance** (GLM ×4): prose-first responses,
   `symbol` on evidence, missing `reproductionSteps` field. Prompt
   contract + field guard shipped; compliance is intermittent (~40%).
4. **Infra/transient** (DeepSeek init timeout ×1): retryable, not
   validation-related.

## System fixes already shipped from these runs

- Lazy stack registration (unselected stacks never block).
- Typed DeepSeek/GLM error passthrough in CLI envelope + schema codes.
- EFTYPE probe hardening; dsh launched via node.
- Sandbox-denial detection scoped to tool events.
- Shell exit-marker observation + nested result-text recursion.
- Operation ledger in DeepSeek + GLM execution prompts.
- `groundingOperationIds` canonical provenance on Evidence.
- Claude owned-process lifecycle (active-set + close escalation +
  `taskkill /PID /T` best-effort on Windows).
- Parse-error shape hints (redacted, bounded).

## Open questions for review

1. **GLM format compliance (~40%)**: prompt placement twice improved
   planning but execution still chats first intermittently. Options:
   (a) keep retrying with variance (it passed individually);
   (b) two-phase serialization turn (investigate, then emit-only-JSON
   in the same session — structural, validation untouched);
   (c) accept that GLM needs more prompt iterations. Forbidden:
   extracting JSON from prose, loosening strict parsing.
2. **DeepSeek code grounding when markers are absent**: ops without
   observed codes can never ground command/test evidence (downgrade
   path only). If Z.AI/DeepSeek log paths for true codes exist
   (`meta`, presentation payloads), wire them in; otherwise accept
   downgrades as honest.
3. **`reproductionSteps` prompt marking**: schema requires the field
   (allows empty array) but the prompt excerpt doesn't mark it
   required — one-line prompt clarification pending (same family as
   the `symbol` guard). Muse calibration line likewise pending.
4. **Muse mega-command invention**: reproduced-strength claims for
   commands never issued that way. Prompt already demands exactness;
   treat as variance unless it repeats.

## What `completed` requires

One `run start --agents muse,deepseek,glm` with all three `completed`,
real overlap, independent outputs, cleanup verified — or `partial`
solely for genuine provider/infra failure (§44). Not yet achieved.
