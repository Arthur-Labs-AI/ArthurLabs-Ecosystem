# Compact stage contracts and live DeepSeek events

Owner authorized compact ordered phase prompts and DeepSeek streaming, then
renaming the branch without codex. Branch renamed locally/remotely to
fix/qa-stage-contracts at db28e70; old remote name removed after equal-SHA check.

## Plan and architecture

1. Source of truth: shared prompt builders in evidence-pipeline; schema-derived
   report contract and existing operation ledger remain authoritative.
2. Ownership: adapters own sessions and observations; coordinator persists events.
3. Dependencies: adapters consume shared builders/SDK facade; no new service/cycle.
4. Boundary: initial safety/mission contract once per session, then small stage
   instructions with frozen plan and compact operation receipt; no peer data.
5. Failure: existing report firewall/repair and checkpoint fallback stay intact.
   DeepSeek primary-stage events stream immediately; final SDK buffer is deduped;
   interrupted tool outcomes remain unknown, never fabricated successful exits.
6. Lifecycle: same private copy/session; plan -> investigate -> report -> optional
   review/refinement. Close owned client on streaming failure, detach late callbacks.
7. Test seams: shared prompt contract tests, real adapter fixture paths, SDK
   notification callback and deferred run barriers (no paid model calls).
8. Compatibility: existing schemas/events/rollback retained; legacy fake sessions
   may return buffered events; GLM transport/sandbox safeguards retained. Latest
   owner request supersedes prior v1.0.2 prompt wording, not provider protections.
9. Observability: genuine tool events persisted mid-turn, no fake heartbeat.
10. Security: common trust/isolation rules retained, same redaction and ownership
    validators, child-session delegation rejected; no new host/network access.

Success: smaller nonduplicated prompts, explicit planning/reporting boundaries,
no repeated completed checks, environment restrictions reported as limitations,
live DeepSeek events before turn settlement, no duplicate events on success,
valid interruption lifecycle. No claim of guaranteed model completion/accuracy
without a funded comparison. Prompt instructions are behavioral constraints;
existing OS sandbox/report firewall remain the enforceable safety boundaries.

## Implementation / verification

Shared builders replace the three copied prompt sets. Mission/authority context
is sent once; planning correction reuses it. Report repair keeps exact check IDs
and the compact operation receipt, with focused path/strength feedback rather
than repeating the whole plan and schema. Existing GLM no-json-schema/tool-firewall
tests remain; old prose/ledger-format assertions changed to pin the new contract
and exact JSON receipt fields, not weaker evidence validation.

Representative fixture (one check and observed test, same small mission):

| Adapter  | Previous characters across planning/investigation/reporting | Current |
| -------- | ----------------------------------------------------------: | ------: |
| OpenCode |                                                       16823 |    7686 |
| DeepSeek |                                                       16811 |    7686 |
| GLM      |                                                       10041 |    7686 |

Measured old builders from db28e70 against the new exported builders. This is
prompt text reduction, not an accuracy or latency benchmark. Dynamic mission,
plan and observed commands remain intact; no arbitrary command/file quotas added.

SDK facade notification regression failed before wiring onNotification and passes
afterward. Barrier-controlled adapter tests prove delivery before idle, final
buffer deduplication, interruption with unknown outcomes, and protocol validity.
Consumer-return regression initially exposed an owned-client leak; a generator
finally now closes it and the regression passes. Live data uses the same observer,
redaction and provenance path as buffered data. Child-session payload is not
forwarded; delegation is rejected.

Windows verification: engine94 PASS (Linux trust excluded), full DeepSeek69 PASS,
GLM102 PASS, shared stage contract3 PASS. Full non-engine39 Turbo tasks PASS at
the broad checkpoint; final static/build60 tasks and final delivery receipts
follow. Format, whitespace and repository hygiene PASS. No paid model run.

## Delivery receipt

- Product implementation380b7e0 pushed to fix/qa-stage-contracts; former local and
  remote codex branch name removed, main/dev unchanged.
- Final non-engine39 Turbo tasks and static/build60 tasks PASS; engine94 PASS.
- Native deployment380b7e0 built18 tasks and passed hello, evidence-pipeline81,
  verifier trust8/8, and actual private preparation/isolation/cancellation smoke.
- Initial native DeepSeek suite was68/69: an existing version-pin test resolved
  the SDK's transitive runtime from the adapter's package. SDK construction and
  production discovery already passed. Strict Linux pnpm correctly exposes that
  dependency only from its owner. Test-only commitdf224dc resolves from the SDK
  manifest instead, retaining the same exact version assertion. No expectation,
  timeout, skip or production dependency changed to conceal the failure.
- Final native deployment1.0.2-df224dc:18 build tasks PASS, current symlink and
  runtime.hello verified, full DeepSeek69 PASS. Product code is unchanged from
  380b7e0; df224dc includes the corrected native test. Windows DeepSeek69 and its
  typecheck/lint PASS after that correction.
- Sentry reopened from this checkout. No active run was cancelled and no paid
  provider run was launched. Funded same-snapshot accuracy/latency comparison
  remains UNVERIFIED. No packaged release/install/upgrade claim is made.
