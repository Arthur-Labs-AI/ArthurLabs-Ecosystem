# Harness Protocol v1

## Vendor-neutral adapter boundary

QA Core speaks only the `HarnessAdapter` contract. OpenCode, DeepSeek, and
GLM through Claude Code normalize their native behavior behind that seam; the generic
domain, schemas, and protocol import no vendor SDK and contain no model branching.

```ts
interface HarnessAdapter {
  getMetadata(): Promise<HarnessMetadata>;
  healthCheck(): Promise<HarnessHealthResult>;
  run(request: HarnessRunRequest): AsyncIterable<HarnessEvent>;
  cancel(runId: AgentRunId): Promise<void>;
  dispose(): Promise<void>;
}
```

Each versioned run request identifies exactly one QARun, AgentRun, AgentStack,
project context snapshot, model, task, and isolated writable workspace derived
from one snapshot. Optional `ExecutionSafeguards` are run/command timeouts. Strict
request validation rejects peer AgentRun IDs, peer stacks, findings, evidence, or
plans, preserving complete agent independence.

## Events and operation correlation

Each event carries `schemaVersion`, `eventId`, `agentRunId`, and an ISO UTC
timestamp. The discriminated union includes lifecycle/status/message events,
correlated tools and commands, file/test activity, initial investigation plan,
emergent hypothesis, findings, evidence, token usage, warnings, and terminal
outcomes.

```text
run.started
agent.status planning
investigation.plan.created
agent.status investigating
tool.started (OperationId)
tool.completed (same OperationId)
test.result
evidence.submitted
finding.submitted
usage.updated
run.completed
```

`OperationId` correlates tool start/completion records; sequence validation
rejects missing, unmatched, or tool-name-mismatched pairs. Events with no
operation semantics require no operation ID. `file.changed` can classify a
test, instrumentation, diagnostic-script, configuration experiment, or other QA
change, while large diffs remain Artifact references.

Embedded Finding, Evidence, Plan, and Hypothesis DTOs own their IDs. Sequence
validation checks their AgentRun and, when supplied, QARun identity. It also
requires one `run.started` first, exactly one completed/failed/cancelled terminal
event last, and one shared AgentRun across the stream.

Phase 2.1 applies these rules incrementally before persistence. Each live stream
retains only its flags and open-operation map. One short transaction stores an
accepted event and all SQLite projections, so later protocol corruption preserves
earlier valid history without leaving a stored event whose domain projection is
missing. Cross-run ownership triggers provide a second persistence-level guard.

## Transport loss and interrupted workers

A worker process can disappear without emitting a terminal event. Such an
incomplete raw stream remains invalid; `sample-transport-loss.ndjson` is a golden
fixture that deliberately fails sequence validation. The Phase 2 coordinator—not
the protocol validator—translates that condition into a
structured `AgentRun.interrupted` such as `HARNESS_PROCESS_CRASH`,
`WORKER_DISCONNECTED`, or `APP_INTERRUPTED`. Previously persisted observable
events, findings, evidence, and usage remain valid.

## HarnessEvent versus RunActivity

`HarnessEvent` is what one harness emits across the adapter boundary.
`RunActivity` is normalized Sentry-owned history for the whole workflow. The
Phase 2 projector converts events into activities, while Sentry directly records
copy, snapshot, context, baseline, merger, verification, and report activity.
Neither the future UI nor human-readable log is the source of truth.

## Framing, failures, and fake

Future workers may stream NDJSON over process or socket transport.
`encodeEventsNdjson`/`decodeEventsNdjson` validate the framing line by line and
raise bounded errors without echoing raw payloads. Structured failures contain a
short code, bounded message, and retryable flag.

`FakeHarnessAdapter` is a deterministic no-AI double with success, failure,
cancellation, finding, evidence, transport-loss, and timeout behavior. Its success
flow includes private planning, correlated tools, and a test result. The Phase 2
coordinator schedules one adapter/request/workspace per selected AgentRun.
