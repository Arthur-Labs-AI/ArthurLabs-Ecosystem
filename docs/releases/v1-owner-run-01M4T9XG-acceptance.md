# Owner Full three-agent run — Windows/WSL, 2026-10-13

**Verified from the supplied export: production Full QA completed 3/3.**
The owner confirmed Windows/WSL and reported that the run worked. This is
successful execution evidence, with exact candidate/archive attribution still
UNVERIFIED. It does not close the entire provider or release acceptance gate.

## Input and scope

| Field                                                   | Evidence                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous host / operator                               | W-owner / project owner; Windows/WSL confirmed in chat                                                                                      |
| Run ID                                                  | `run_01M4T9XGTM1S41PS74NA0G767Z`                                                                                                            |
| Supplied file                                           | `sentry-run_01M4T9XGTM1S41PS74NA0G767Z.json`                                                                                                |
| Exact file SHA256                                       | `f6bae8c38f20f1dab1fed6570a525e4d38afa49e88cd05cfd94b078dcfefdee8`                                                                          |
| Format                                                  | schemaVersion1, exportKind `sentry.agent-run`                                                                                               |
| Execution                                               | `production`, `full`, `completed`; three configured/completed agents, zero failed/interrupted                                               |
| Local execution time                                    | October13, 12:36:22–12:50:17 Europe/Sofia; elapsed834.789 seconds                                                                           |
| Sentry full source SHA / archive / archive SHA256       | UNVERIFIED: not supplied in this export or owner response                                                                                   |
| Selected campaign candidate, not attributed to this run | `d250e4cabdae7735af5905146db8d7806fe4427c`                                                                                                  |
| Snapshot                                                | `snap_01M4T9XGY41CZY0A4QGAD9YQG8`; all three investigation plans reference the same run snapshot/context                                    |
| Raw data retention                                      | Original retained privately; duplicate and audit under ignored `dist/owner-campaign`; no raw export/project paths/provider stores committed |

Agent runtime identities identify models/adapters, not the Sentry build commit.
Linux executable paths do not distinguish WSL from native Linux by themselves;
host attribution here comes from the owner's explicit confirmation. W-owner is
not silently assigned the agent's isolated W1 archive or profile. No provider
calls were initiated by the agent; this receipt reviews an already completed
owner-operated run and grants no future spending scope.

## Actual agent results

| Agent    | Model                                    | AgentRun ID                       | Status    | Findings | Evidence | Tool starts/completions |
| -------- | ---------------------------------------- | --------------------------------- | --------- | -------: | -------: | ----------------------- |
| OpenCode | `opencode-go/muse-spark-1.3-contributor` | `arun_01M4T9XH2AD9MKXSD8MG0ESAHT` | completed |        0 |        3 | 18 / 18                 |
| DeepSeek | `deepseek-v4-flash`                      | `arun_01M4T9XH2ZVG377NVTB96AR9R1` | completed |        5 |       17 | 16 / 16                 |
| GLM      | `glm-5.3-flash`                          | `arun_01M4T9XH3FKKXZVMQ9QXDHSQ2F` | completed |        5 |       18 | 19 / 19                 |

Adapter/SDK identities: OpenCode opencode/1.18.32; DeepSeek
deepseek-harness/0.1.5-rc.2; GLM claude-code/2.1.270. All AgentRun task types
are qa. Zero OpenCode findings is an actual completed result, not a failure or
a missing result. The ten findings concern the inspected project; their text
was not published or independently reproduced as Sentry defects.

## Executed export checks

Private audit command: `node dist/owner-campaign/audit-owner-run.mjs`, exit0.
Existing compiled repository schemas validated609 records, including all294
harness events. No schema or checked relationship failures were found.

| Check                                                                   | Verdict                   | Observation                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production Full completion                                              | PASS                      | Parent summary agrees with three selected, distinct, completed qa AgentRuns; no failed/interrupted agents                                            |
| Attribution                                                             | PASS                      | All findings/evidence belong to this run and valid AgentRuns; finding source stack matches its agent; referenced evidence belongs to that same agent |
| Event/canonical consistency                                             | PASS                      | Embedded submitted finding/evidence objects equal exported canonical records; 10 finding and38 evidence submissions                                  |
| Tool lifecycle                                                          | PASS                      | 53 starts pair with53 completions; no duplicate start IDs or open operations; no recorded nonzero tool exit or infrastructureFailure=true            |
| Terminal event accounting                                               | PASS                      | One start and one completed terminal event per AgentRun, unique event IDs and increasing per-agent sequences                                         |
| Snapshot/context metadata                                               | PASS                      | Run/revision/project identities agree; all plans use the same snapshot/context; snapshot and revision contentHash agree                              |
| Mandatory legacy stages absent in this run                              | PASS                      | mergeResults0 and verificationRuns0; all three completed independently                                                                               |
| Exact D/archive identity                                                | OWNER ACCEPTANCE REQUIRED | Sentry source SHA/archive checksum absent; successful execution cannot be assigned to the selected bytes yet                                         |
| Snapshot bytes unchanged throughout execution                           | NOT RUN                   | Only summary/hash metadata supplied; manifest/material and before/after bytes not provided                                                           |
| Persisted DB and JSON/log equivalence; reopen                           | NOT RUN                   | Only one JSON export supplied; json/log artifact metadata is present, but artifact bytes/DB/reopen observation were not independently compared       |
| Global duplicate paid calls / other runs                                | NOT RUN                   | One AgentRun per selected stack in this export; no account/network/other-run audit or spend verification                                             |
| Partial failure, cancellation, interruption, active maintenance, retest | NOT RUN                   | Successful Full run does not exercise those scenarios                                                                                                |
| Other13 combinations/modes and native CachyOS                           | OWNER ACCEPTANCE REQUIRED | Not exercised by this Windows Full all-three run                                                                                                     |

Warnings are preserved: OPENCODE_PLANNING_RETRY1, OPENCODE_LIMITATION3,
DEEPSEEK_LIMITATION8, GLM_WINDOWS_PROFILES_HIDDEN1, GLM_REPORT_RETRY1,
GLM_LIMITATION6 (20 total). All three agents nevertheless completed. Planning
and report retry warnings are visible; absence of duplicate provider calls is
not inferred from the parent status. This receipt does not claim warning-free
execution or independent confirmation of the agents' target-project findings.

## Acceptance disposition

E07-Full execution is successful on owner-confirmed Windows/WSL. The selected-D
W1 row remains OWNER ACCEPTANCE REQUIRED until build/archive identity and the
remaining E07 observations are supplied; C1 receives no native credit. Existing
W1/C1 verdict counts are unchanged. Preserve this evidence separately rather
than rewriting the earlier campaign's pending-log state as though it were known
at the time.

PR15 was subsequently verified owner-merged into dev at
`aef67903ac0ef1a42a5bf3ebd2626c4603152688`; postmergeCI38376341094 completed
SUCCESS. That integration only adds documentation/evidence/protocol records;
production paths remain identical to D. Neither its merge nor this export proves
which installation produced the owner run. The [campaign report](v1-owner-acceptance-execution.md)
and [checklist](V1_ACCEPTANCE_CHECKLIST.md) retain the
[P1 G10 rollback failure](v1-beta-rollback-credential-proposal.md), native/clean-host
and remaining provider/recovery requirements. No feature-freeze or Phase6
authorization is inferred from the owner's successful run report.
