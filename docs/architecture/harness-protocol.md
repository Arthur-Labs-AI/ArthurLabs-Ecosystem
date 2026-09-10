# Harness Protocol v1

## Why vendor APIs are isolated

Muse Code, DeepSeek Harness, and Claude Code SDKs evolve independently and leak
vendor concepts (auth, transports, tool schemas) that must never infect the QA
domain. The `HarnessAdapter` interface in `@qa/harness-protocol` is the single
seam: QA Core speaks one semantic contract; each future worker (Muse worker,
DeepSeek worker, Claude/GLM worker) implements it. Swapping transports
(in-process, worker process, NDJSON, JSON-RPC, socket, container) changes the
adapter, never domain behavior. The package has zero vendor SDK dependencies.

## Adapter semantics

```ts
interface HarnessAdapter {
  getMetadata(): Promise<HarnessMetadata>; // identity + capabilities
  healthCheck(): Promise<HarnessHealthResult>; // binary/creds/runtime/model checks
  run(request: HarnessRunRequest): AsyncIterable<HarnessEvent>; // streamed run
  cancel(runId: AgentRunId): Promise<void>; // cooperative cancellation
  dispose(): Promise<void>; // release resources
}
```

- **Metadata**: adapterId/version, protocolVersion, displayName, capabilities,
  optional model patterns and OS lists (patterns, never exact model enums).
- **Capabilities**: streaming, cancellation, filesystemRead/Write, shell, browser,
  sessionResume, structuredOutput, usageReporting — universal only; vendor extras
  go in optional extension fields.
- **Health**: healthy|degraded|unavailable + per-check pass|warn|fail entries
  (binary installed, credentials, runtime, model reachability…).
- **Run request** (`schemaVersion: 1`): agentRunId, qaRunId, workspace
  (runtimePath — opaque to the core — snapshotId, writable), open ModelDefinition,
  task (type, prompt = the mission, policyId/version, context), optional limits.
- **Events**: versioned discriminated union on `type` (16 variants: run.started …
  finding/evidence.submitted … run.completed/failed/cancelled). Every event carries
  schemaVersion, eventId, agentRunId, ISO UTC timestamp. Finding/evidence events
  embed validated Finding/Evidence payloads. Their embedded IDs are authoritative;
  there is no redundant event-level findingId or evidenceId. Usage cost exists only
  inside AgentUsage.
- **Failures**: structured `{ code, message, retryable }` (e.g.
  `HARNESS_PROCESS_CRASHED`, retryable).
- **Versioning**: protocol v1 independent of per-entity `schemaVersion`; strict
  today, migration principles in ADR-0003.

## Future NDJSON worker transport

Production workers will stream one JSON object per line over stdio/sockets.
`encodeEventsNdjson` / `decodeEventsNdjson` (validated line-by-line) already
implement that framing; golden fixtures in
`packages/harness-protocol/tests/fixtures/harness/` pin the wire shape
(`sample-success.ndjson`, `sample-failure.ndjson`, `sample-cancelled.ndjson`).
Malformed framing and events raise bounded `HarnessProtocolError` values with a
stable code and location, without echoing full raw payloads.

## Collected stream integrity

Individual Zod event validation and collected-stream validation are separate.
`validateHarnessEventSequence` enforces exactly one `run.started` first, one
terminal event (`run.completed`, `run.failed`, or `run.cancelled`) last, no events
after termination, and one shared AgentRun ID. It also checks that embedded
Finding/Evidence AgentRun IDs match their event and can validate embedded QARun IDs
against the originating request. Short started→terminal streams remain valid.

## Complete example event stream

```text
run.started → agent.status → tool.started → tool.completed →
evidence.submitted → finding.submitted → usage.updated → run.completed
```

```json
{"schemaVersion":1,"eventId":"evt_01…","agentRunId":"arun_01…",
 "timestamp":"2026-09-09T19:00:00.000Z","type":"run.started"}
{"schemaVersion":1,"eventId":"evt_02…","agentRunId":"arun_01…",
 "timestamp":"2026-09-09T19:00:02.000Z","type":"tool.started",
 "tool":{"name":"shell","inputSummary":"npm test"}}
{"schemaVersion":1,"eventId":"evt_03…","agentRunId":"arun_01…",
 "timestamp":"2026-09-09T19:03:00.000Z","type":"finding.submitted",
 "finding":{}}
{"schemaVersion":1,"eventId":"evt_04…","agentRunId":"arun_01…",
 "timestamp":"2026-09-09T19:04:00.000Z","type":"run.failed",
 "failure":{"code":"HARNESS_PROCESS_CRASHED",
  "message":"Harness process exited unexpectedly","retryable":true}}
```

## Fake adapter

`FakeHarnessAdapter` implements the contract deterministically without AI
(scenarios: success, failure, cancellation, finding, evidence), validates every
event before yielding it, and tracks cancellation per AgentRun ID. It is the
primary Phase 2 development double.
