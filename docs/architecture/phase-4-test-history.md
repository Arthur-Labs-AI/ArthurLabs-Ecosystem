# Phase 4 — Complete Live-Test History

Shareable record of every live validation run: what was tested, what failed
per model, the root cause, and the fix. Failure messages below are quoted
from the persisted run database (`qa run show <runId>`).

## Individual stack smokes (Phase 4.1 baseline)

| Run                              | Stack    | Result       | Notes                                                   |
| -------------------------------- | -------- | ------------ | ------------------------------------------------------- |
| `run_01M2DVW6BG7Y7BCXDHEB80QRSV` | DeepSeek | ✅ completed | 2 confirmed findings, 6 evidence                        |
| `run_01M2EBSC5XCPEKTT8TH6DJREM3` | GLM      | ✅ completed | 4 findings, 7 evidence, `glm-5.3-flash` verified on key |
| Muse (Phase 3.1.1)               | Muse     | ✅ completed | Prior phase baseline                                    |

## GLM solo debugging series (prompt hardening, all correctly rejected)

| Run                              | Error                                                                                                               | Root cause                                                 | Fix (commit)                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `run_01M2E72PN233F78QEKSPPKPEN5` | `GLM_INVALID_RESULT: planning response was not one complete JSON document`                                          | Model returned prose instead of raw JSON                   | Planning OUTPUT CONTRACT (`1d67025`)                       |
| `run_01M2E7F34Q9AJ95VQZKYXH43ZC` | Same planning error (2nd time)                                                                                      | Systematic, not variance                                   | Same fix verified working next run                         |
| `run_01M2E826Z6007NB798K9WBPTQR` | `GLM_START_FAILED: --session-id can only be used with --continue or --resume if --fork-session is also specified`   | Execution turn passed `--resume` + `--session-id` together | Resume with `--resume` alone (`d9eb089`) + flag-shape test |
| `run_01M2E8TB67YJZ3KWKG8586Q60B` | `evidence.4: Unrecognized key 'symbol'`                                                                             | Model put finding-location field on evidence               | Evidence field guard (`389457e`)                           |
| `run_01M2EATA14E15P658SDQDA56ZA` | `execution response was not one complete JSON document (response starts with: "I'll execute the frozen plan now…")` | Execution prompt lacked the output contract                | Execution OUTPUT CONTRACT (`3dbbdb0`)                      |

## Three-agent parallel runs (4.1 architecture → 4.2 architecture)

| Run                                  | Result                         | Muse                                                                                     | DeepSeek                                                                              | GLM                                                                                                                         |
| ------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `run_01M2ECSQ5TAS124X30GAZNGVGK`     | partial (122 evts)             | ❌ reproduced mega-command never observed (`node --experimental-strip-types … -e "…"`)   | ❌ `evidence.6–9: Unrecognized key 'symbol'`                                          | ❌ execution text starts with JSON but is not one complete document                                                         |
| `run_01M2EDS6YTKMQD0YXBABSHADDW`     | partial                        | ✅ completed                                                                             | ❌ exit-code mismatch on unlinked citation (our default-0 bug)                        | ❌ cited `node_modules` directory as evidence path                                                                          |
| `run_01M2EFDHJYHGBX3MKMWGNTW5ZK`     | partial                        | ✅ completed                                                                             | ❌ reproduced claim on codeless op                                                    | ❌ execution prose-first                                                                                                    |
| `run_01M2FKTDPVFRDYRQ85WCCZXPVF`     | partial (128 evts, 2 findings) | ✅ completed                                                                             | ❌ `DEEPSEEK_START_FAILED: initialize timed out after 30000ms` (transient, retryable) | ❌ overconfident `confirmed` on manual evidence                                                                             |
| `run_01M2FMWJ70CA9SKEX2PKB6ZE2K`     | **failed** (102 evts)          | ❌ overconfident `confirmed` (Muse prompt lacked calibration)                            | ❌ reproduced test on unobserved exit code                                            | ❌ `findings.3/4.reproductionSteps: Required` (field omitted)                                                               |
| `run_01M2FWT43HCPC2ZKX4AS8M87B8`     | **failed** (93 evts)           | ❌ report `checks.0: Expected object, received string` (envelope shapes never described) | ❌ same envelope-shape failure                                                        | ❌ `GLM_START_FAILED` (scrub/permission spawn refusal)                                                                      |
| `run_01M2FVDMBHMYCS7QHNESHDAFXD`     | failed                         | ❌ Meta network timeout on report turn (transient)                                       | ❌ empty planning response (transient)                                                | ❌ spawn failure (see below)                                                                                                |
| `run_01M2FVMY87D25DB41Y25YEQVMT`     | failed                         | ❌ planning prose (rogue investigation in turn 1)                                        | ❌ `strength: 'strong'` (abbreviated enum)                                            | —                                                                                                                           |
| `run_01M2FZTFS7V826W3PH4D3098XM`     | failed (71 evts)               | —                                                                                        | —                                                                                     | ❌ `GLM_REPORT_TOOL_FORBIDDEN` (tool call in report turn; firewall worked, but trips failed the run instead of the attempt) |
| `run_01M2G6SMYY2THF9R4JKNDJ1KSF`     | partial (119 evts, 6 findings) | ❌ `RUN_TIMEOUT` — 2 events then 30 min silence (Meta-side hang, transient)              | ✅ completed (3 turns)                                                                | ✅ completed (4 turns, repair path used)                                                                                    |
| **`run_01M2G9C6H4YVYX4F75CH1DHA36`** | ✅ **completed** (152 evts)    | ✅ 3 turns, 180s                                                                         | ✅ 3 turns, 5845/18086/36736 tokens                                                   | ✅ 3 turns, 120542/10736/142592 tokens                                                                                      |

Final run: 9 findings (8 strong + 1 probable), 22 evidence incl.
op-grounded commands with canonical IDs, same snapshot, separate
workspaces (all removed), no stray processes, fixture intact, zero
secret hits, `json` + `log` exports.

## Individual 4.2 regressions

| Run                              | Stack         | Result                                                                  |
| -------------------------------- | ------------- | ----------------------------------------------------------------------- |
| `run_01M2G2BZ3HKBFT724XAM1W70W6` | GLM           | ✅ completed, 3 turns, 4 findings — `--json-schema` works on Z.AI route |
| `run_01M2G4QXJAMPFT4EE9C2VFZP0S` | Muse          | ✅ completed, 3 turns, 2 findings                                       |
| `run_01M2G4YWHDJWDR3EENGPD4RMQS` | DeepSeek      | ✅ completed, 3 turns, 1 finding                                        |
| `run_01M2G93HSA5HEFYVK2M8JS3TH5` | Muse (re-run) | ✅ completed, 3 turns, 129s — parallel hang proven transient            |

## The core issue (why runs kept failing)

Two-stage `planning → investigation + final JSON` forced the model to
cite Sentry-owned operation identities (`op_N`, exit codes) in the same
turn that created them. The execution prompt could only list operations
known _before_ the turn — everything observed _during_ it had to be
reconstructed from memory. Combined with single-shot serialization
gates fed by nondeterministic models, every run was an independent
roll: P(all three comply) ≈ P³. Prompt sentences raised P; they could
never make it 1.

Additional defects found along the way (all fixed, none of them model
variance): our own exit-code default-0 fabrication, markers not
reaching logged session events, `--resume` + `--session-id` conflict,
a missing envelope-schema description, an undescribed strength
vocabulary, and firewall trips failing runs instead of attempts.

## How it was solved (Phase 4.2)

- **Three stages**: planning → investigation (tools live here, prose
  ignored) → tool-free reporting against the **frozen
  post-investigation ledger** (shared renderer, identical on all
  stacks). Models never reconstruct numbering from memory.
- **ReportV2**: discriminated evidence union; command/test evidence
  cite `operationKey` only — Sentry derives text/codes/status from the
  frozen operation, making whole failure classes (mega-commands, code
  mismatches, `symbol` bleed) impossible by construction.
- **Bounded repair**: report correction (initial + 1, same session, no
  tools, same ledger), planning correction (initial + 1, ledger not
  frozen yet), firewall trips fail the _attempt_ with tool-free
  correction feedback. Strict validation never relaxed.
- **GLM `--json-schema`** with the derived ReportV2 schema first,
  strict-JSON fallback on transport failure (verified working live).
- **Actual turn accounting** (3+ turns, never hardcoded) with
  `*_RETRY` telemetry.

## Final report

- Baseline `76d517a` → final `978e1ad` (all pushed, tree clean).
- Deterministic gates: hygiene, format, lint 15/15, typecheck 29/29,
  test 30/30 tasks (Muse 42+1, DeepSeek 22, GLM 27, schemas 106,
  pipeline 14), build 15/15.
- Exact-head CI: `34866187226` on `978e1ad` — completed/success.
- Live: all three individual regressions + three-agent parallel smoke
  `run_01M2G9C6H4YVYX4F75CH1DHA36` — completed, 3/3, production.
- No Merger, no Verifier. Architecture ready for the deterministic
  Merger phase.

> **Sentry Phase 4 is complete. Muse, DeepSeek, and GLM now execute
> independent full-QA investigations in parallel using a three-stage
> planning, investigation, and tool-free reporting protocol. Sentry
> freezes the authoritative operation ledger only after investigation,
> models no longer reconstruct evidentiary facts from memory,
> structured reports are validated without weakening trust guarantees,
> and report-only correction avoids repeating expensive
> investigations. The three real AgentStacks have been live-validated
> against the same immutable project snapshot and the architecture is
> ready for the deterministic Merger phase.**
