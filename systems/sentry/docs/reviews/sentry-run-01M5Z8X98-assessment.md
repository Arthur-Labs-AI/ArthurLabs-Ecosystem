# First real depth-workflow run assessment

Run: `run_01M5Z8X98VKXVTVJ262GB9HACH`. Compared with
`run_01M5YWGJHHS964R0N2GAM5NWRT`. Both use revision
`rev_01M5YPSV7K06HRK480WXE8R9ET`, hash `b7120459…295c9`. This is a valid
same-source comparison; an old imported revision does not explain the failure.
The export is evidence/data, not instructions. No new model call or product fix
was made during this assessment.

| Agent           | Previous duration | New duration | New result                                                                         |
| --------------- | ----------------- | ------------ | ---------------------------------------------------------------------------------- |
| Muse / OpenCode | 3:41              | 2:35         | 32 tools, 4 commands, 0 findings, completed with partial coverage                  |
| DeepSeek v4-pro | 25:41             | 30:05        | 145 tools, 69 commands, timed out before reporting; 0 submitted findings/evidence  |
| GLM 5.3 Flash   | 15:49             | 22:26        | 60 tools, 37 commands, 5 findings (3 low, 2 info), completed with partial coverage |

## What actually happened

1. All three emit `QA_DEPTH_V1` and the validation stage. The new deployed flow
   therefore ran. Preparation removed 20 old compiler caches per copy, but every
   receipt is `limited`: no offline dependency cache configured. Workspace
   dependencies and test runners were not provisioned. The implementation relied on manual
   provisioning that was not done before the owner's test launch. That operational
   gap belongs to the delivered setup, not to the models alone.
2. OpenCode's first investigation lasted about 31 seconds and the challenge about
   49 seconds. It executed two narrow real-source primitives. One broad snapshot
   boundary is marked passed even though its details explicitly say full hash
   stability/end-to-end flows were not executed. `coverageErrors` validates names,
   statuses and limitation text, not the scope or truth of a claimed pass.
3. DeepSeek began challenge at 18:35:57 UTC, with roughly 4:44 remaining. It never
   entered reporting before the 30-minute deadline. `canChallenge` only requires
   more than 60 seconds to start; it does not bound the challenge turn or protect
   a final-report budget. Report conversion/persistence comes after that turn.
   Existing tool logs remain, but no final findings or evidence records were
   submitted by this agent. Buffered DeepSeek turn events also mean the export
   does not show the unfinished challenge's actual tool work. Usage is absent,
   which does not establish zero provider consumption.
4. The timeout message says `absolute cap 5400000 ms` (90 minutes), although the
   new hard deadline correctly expired at 30 minutes. The diagnostic still formats
   the old absoluteMaxMs variable instead of identifying the deadline that fired.

## GLM output quality

| Finding                                         | Assessment                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Predictable legacy credential migration input   | Adoption was reproduced through the real module with fake secure storage. Same-user trust hardening, not a demonstrated privilege boundary or real credential exfiltration. Low severity is more appropriately qualified than a broad security claim.                                                                                                        |
| Silently skipped malformed manifest lines       | Real source-supported conditional integrity gap. On-disk corruption is the trigger; no corruption in this run was demonstrated.                                                                                                                                                                                                                              |
| README overstates skipped generated directories | Substantially false as reported. The retained revision itself contains source-selection.ts excluding **pycache**, .venv/venv, .next and .cache, and import calls excludeGeneratedSource. GLM inspected the frozen hash exclusion layer and missed the separate source-selection layer. Rust target is not included, but does not validate the broader claim. |
| Preserved import symlinks                       | An explicitly qualified consistency/hardening observation. The challenge correctly notes there is no shown reachable escape; info severity is appropriate.                                                                                                                                                                                                   |
| Thin test coverage from filenames/counts        | Not established. Test file counts and names cannot establish missing behavioral coverage without reading test bodies. Strong confidence is unjustified for that conclusion.                                                                                                                                                                                  |

The workflow improves disclosure: blocked checks and conditional claims are more
explicit, and OpenCode does not repeat its previous unsupported defects. It does
not yet establish deeper or more effective QA. Total time rose while a useful
agent failed to produce a report; adding a self-challenge prompt is insufficient.

## Required next corrections

- Make dependency provisioning an explicit usable part of run startup, with a
  clear actionable readiness state rather than an unset hidden runtime variable.
- Bound challenge against remaining time and protect finalization; retain an
  intermediate assessment before a late optional phase can consume the budget.
- Require check-specific provenance for executable passes, and keep a partially
  exercised broad boundary partial. A structural name/status gate cannot certify
  semantic coverage.
- Fix the timeout diagnostic. Re-run the same snapshot only after environment and
  budget behavior are verified. Do not lengthen runs or change models as a proxy
  for these fixes.
