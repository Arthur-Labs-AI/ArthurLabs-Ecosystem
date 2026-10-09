# M04.7A — Automatic Connections: zero-edge investigation

## Finding
The event path is intact. On the affected desktop the integration ledger holds a `done` entry for every one of the four new
ideas and the switch is enabled, so: events were emitted, the worker received them, the switch was read at run time, and each
run finished without a provider error. Twelve end-to-end tests (`graph/event_path_tests.rs`) drive real capture → distillation →
`ChangedKnowledge` → `admit`/`process` → Stage A → Stage B → policy → persistence → read-back with scripted models and pass.

What was *not* knowable: what Stage A / Stage B returned for those four ideas. A run that proposes nothing, or whose proposals
are all rejected by the (deliberately strict) checks, is recorded `done` and the UI said only "No new connections found."
That sentence was used for every cause. No threshold, model or relation semantics were changed.

## What "Find connections" does
`infer_relations`: real Stage A over up to 40 recent ideas of one project, then two Stage B votes. Fewer than two ideas → no model
call. It returns only newly stored relations; existing ones (including your manual ones) are not re-reported.

## What was added
* `graph/diagnostics.rs`: counters and the codes NO_CANDIDATES, ALL_REJECTED, PROVIDER_FAILED, PERSISTENCE_FAILED,
  SUCCESS_NO_NEW_EDGES (plus WORKER_NOT_STARTED / EVENT_NOT_DELIVERED / DISABLED / NO_EVENTS_YET as the overall diagnosis).
  Counts and ids only — never capture text, idea bodies, keys, headers or model output.
* `get_graph_integration_diagnostics` command, `GraphDiagnostics` contract, ArthurClient method.
* Find connections reports the specific reason; Settings → Automatic Connections has a "What Automatic Connections has done" panel.

## Verifying in the app
Settings → Automatic Connections → open the panel, add an idea, press Refresh. Or press Find connections and read the message.
