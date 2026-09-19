# Phase 8 — Agent Telemetry Projection

Source of truth: persisted `HarnessEvent` + `RunActivity` + `Finding` + `Evidence` + `AgentRun`.
Implementation: `apps/desktop/src/renderer/lib/agent-telemetry.ts` (`projectAgentTelemetry`).

## UI stages

| UI stage           | Backend evidence                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Preparation        | AgentRun exists (`queued`/`starting`); trivially complete once started                                 |
| Planning           | `agent.status(status=planning)` · `investigation.plan.created` · `investigation.hypothesis.discovered` |
| Investigation      | `agent.status(status=investigating)` · `file.read` / `file.changed` · `investigation.*`                |
| Runtime Validation | `tool.started` / `tool.completed` · `command.executed` · `test.result`                                 |
| Evidence           | `finding.submitted` / `evidence.submitted`, or persisted Finding/Evidence rows                         |
| Reporting          | `agent.message` (bounded) · `usage.updated` after evidence, before `run.completed`                     |
| Completed          | `run.completed` (all stages completed)                                                                 |

Terminal overlays: `failed`/`timed_out` mark the furthest reached stage `failed`; `cancelled`/`interrupted` mark it `cancelled`; earlier stages stay `completed`. `TIMED OUT` and `INTERRUPTED` are labeled distinctly, never as `FAILED`.

## Current operation

1. Latest `tool.started` whose `operationId` has no matching `tool.completed` → `COMMAND` + bounded `inputSummary`.
2. Else latest running/waiting `RunActivity` → its kind + title.
3. Else latest useful event (`file.read` → `Reading: <path>`; `command.executed` → command + exit; `test.result` → suite + passed/failed; `finding`/`evidence` → submitted; lifecycle → status line).
4. Else `Working` (or `Activity unavailable`). Never synthesized thoughts, never percentages, never ETAs.

## Recent activity (latest 2–4, high-value only)

Prioritized: `command` · `file read` · `search` (tool input summaries) · `test` · `HTTP/API` (tool events) · `finding` · `evidence` · `warning` · `failure` · `cancellation` · `report`. Heartbeat/persistence internals are hidden.

## Timeline categories → icons

| Category                         | Sources                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Lifecycle                        | `run.started/completed/failed/cancelled`, `agent.status`                       |
| File                             | `file.read`, `file.changed`                                                    |
| Search                           | tool events whose input summary is a query (labeled from `inputSummary`)       |
| Command                          | `tool.started/completed`, `command.executed`                                   |
| Test                             | `test.result` (honest counts only)                                             |
| Evidence / Finding               | `evidence.submitted`, `finding.submitted`                                      |
| Warning / Failure / Cancellation | `warning`, `run.failed` (+ structured code/message/retryable), `run.cancelled` |
| Report                           | `agent.message`, `usage.updated`                                               |

## Honesty rules

- No `Thinking…`, no quoted inner monologue, no chain-of-thought stream, no reasoning-token content.
- No `73%` / `2 minutes remaining`: progress is the stage checklist (✓/●/○) only.
- File/command/test lines render only what events/activities persist (bounded excerpts; full IDs on hover/copy).
- Counts use persisted rows; tokens show `—` for unknown (zero means genuinely zero). No monetary costs.
- `Model pending` shows when no runtime identity is persisted; configured stacks show `Waiting` before start.
