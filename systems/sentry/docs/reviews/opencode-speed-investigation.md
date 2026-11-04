# OpenCode speed investigation — 2026-10-27

Scope: explain the owner's persistent timing difference using nine supplied
Desktop run exports and the current dev adapter implementation. No provider run,
model setting change, dependency installation or product fix was performed.

## Observed history

Seven exports contain a successfully completed Muse Spark OpenCode agent and a
completed peer. Muse is fastest in all seven. Different projects, snapshots and
peer models make this observational history, not a controlled benchmark.

| Run suffix | OpenCode / Muse | DeepSeek |   GLM |
| ---------- | --------------: | -------: | ----: |
| 7Y458R8    |            3:28 |     6:10 |  9:06 |
| 5F3R93     |            1:07 |     3:48 |  9:20 |
| T37X06     |            4:17 |        — | 20:31 |
| A0G767Z    |            1:22 |     4:53 | 13:54 |
| TS0X0VPTK  |            2:39 |     3:51 | 12:00 |
| BCA8Q8     |            5:08 |    30:24 | 16:47 |
| M5NWRT     |            3:41 |    25:41 | 15:49 |

The selected model is `opencode-go/muse-spark-1.3-contributor`. OpenCode is the
client/adapter, not the model name. The export for
`run_01M5SWNX0RRAB3QFKB6TGF55CS` uses `opencode-go/mimo-v2.6-flash` and records
an unsuccessful 31:59 execution. This is a counterexample to the adapter always
finishing quickly, although it is not a successful quality comparison.

## Last run: where time went

Source: exported `agent.status` timestamps and AgentRun completion timestamps for
`run_01M5YWGJHHS964R0N2GAM5NWRT`. Phase times exclude roughly two seconds of
initial preparation and are rounded. Planning can itself include file reads and
tests; these labels do not measure pure model reasoning or idle time.

| Agent           | Planning | Investigation | Reporting | Observed tools | Shell commands |
| --------------- | -------: | ------------: | --------: | -------------: | -------------: |
| Muse / OpenCode |     0:40 |          1:57 |      1:02 |             44 |              6 |
| DeepSeek v4-pro |    10:49 |          9:37 |      5:14 |            112 |             63 |
| GLM 5.3 Flash   |     5:51 |          2:47 |      7:09 |             53 |             44 |

GLM's longer total duration therefore does not demonstrate a much longer
investigation. The preceding run shows the same distinction: Muse investigation
3:36, GLM 2:59, DeepSeek 17:36. A previous explanation that equated total duration
with investigation depth was too broad.

OpenCode tool observations are emitted after a headless turn returns; grouped
timestamps are observation times, not individual tool start times. Tool counts
are comparable only approximately because agents have different tools and batch
commands differently. Usage `turns` is also not comparable: OpenCode reports
model step counts; the other adapters report different session-turn units.
Token counts do not establish model throughput or reasoning effort.

## Mechanisms confirmed in source and logs

1. **No short OpenCode stop budget found.**
   `packages/harness-opencode/src/adapter.ts:190` defines a 60-minute per-turn
   ceiling. The run engine supplies a shared parent run timeout; this export
   records 30 minutes. Successful Muse runs finish far below either ceiling.
   No step/command/file cap or explicit low reasoning effort is injected by
   the inspected OpenCode config builder and client invocation.

2. **The model controls investigation completion.**
   `investigationPrompt` asks the model to finish when investigation is complete.
   The adapter awaits exactly one investigation `runTurn`, then enters the
   tool-free reporting turn. There is no independent semantic review/rebuttal
   pass before this transition. Report conversion checks evidence trust and
   locations; it does not execute a finding's reachable failure path. Source
   references can legitimately support `strong`, so source-only hypotheses can
   become reported findings without runtime reproduction. This is a general
   pipeline property, not a limit applied only to OpenCode.

3. **Muse does less behavioral validation in the last run.**
   Its six shell commands include environment discovery, copied transition/path
   logic and a dependency-free distribution test. The agent explicitly reports
   unavailable node_modules and no Vitest/typecheck/lint execution. Copied logic
   establishes a local condition but does not establish a reachable application
   failure. This matches the review's conditional/unsupported findings.

4. **Dependency handling makes the comparison unequal.**
   OpenCode and GLM treat missing dependencies as a testing limitation. DeepSeek
   executes `pnpm install --frozen-lockfile --ignore-scripts`; the logged result
   reports 1009 added packages, zero downloaded, and six seconds. It then runs
   real package tests/build/typecheck and a RunCoordinator reproduction. The
   installation itself does not explain the large timing gap; the additional
   verification it enables does. Provisioning should be explicit and consistent
   rather than dependent on agent initiative and cache visibility.

5. **Prompt intent is broadly equal; behavior is not.**
   OpenCode and DeepSeek use the same shared investigation methodology,
   anti-superficial rules, reproduction guidance and coverage guidance. Both
   forbid network dependency downloads. GLM uses the preserved v1.0.2 wording,
   which differs. Host user/project OpenCode configuration is scrubbed/masked;
   catalog defaults remain authoritative for model behavior. No evidence was
   found that Sentry explicitly disables Muse reasoning. Provider-internal
   defaults, inference speed and reasoning effort were not measured, so they
   cannot be identified as a proven root cause.

## Conclusion and next action

The demonstrated persistent difference belongs to the Muse-plus-OpenCode
combination: it returns phase results quickly and ends validation sooner. Sentry
accepts that completion without a separate semantic sufficiency decision. Peer
time also includes substantially slower planning/reporting, and DeepSeek performs
more executable verification after restoring cached dependencies.

Do not fix this by sleeping, forcing a minimum duration or setting arbitrary
command counts. Useful changes would be deterministic workspace toolchain
provisioning; a finding challenge that traces the actual caller and realistic
trigger before claiming impact; and distinct source-backed versus reproduced
result presentation. Compare with a controlled same-snapshot test before
attributing the remaining difference to model quality or throughput. No such
paid experiment was started by this investigation.

Verification executed: `pnpm --filter @qa/harness-opencode exec vitest run
tests/qa-prompt-parity.test.ts --maxWorkers=1 --minWorkers=1` — one test passed.
This verifies guidance delivery, not model compliance or finding correctness.
`shux contract` was attempted but unavailable; protocol receipts updated directly.
