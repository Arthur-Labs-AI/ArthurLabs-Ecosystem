# Agent Stack

```text
AgentStack = Model + Harness + Execution Requirements + QA Policy
           + optional ExecutionSafeguards
```

The stack is the unit the QA Core schedules: one `AgentRun` = one stack × one
task inside one `QARun`. The domain reasons about stacks generically — there is
no `if (model === 'muse')` anywhere; vendor specifics belong in future adapters.

`ExecutionSafeguards` contains operational controls only: `runTimeoutMs` and
`commandTimeoutMs`. They are process safety boundaries, not product quotas.
Turn, token, and monetary limits are deliberately absent.

## Today's configurations (fixtures, not product constants)

- **Muse QA Agent** = Muse 1.3 Contributor (`provider: meta`) + Muse Code
  (`adapterId: muse-code`) — `stack_muse_main`
- **DeepSeek QA Agent** = DeepSeek V4 Flash (`provider: deepseek`) + DeepSeek
  Harness (`adapterId: deepseek-harness`) — `stack_deepseek_main`
- **GLM QA Agent** = GLM-5.3-Flash (`provider: zai`) + Claude Code
  (`adapterId: claude-code`) — `stack_glm_main`

Each fixture carries `policy: qa-standard v1`, `execution: {}`, and protocol v1
expectations. Execution capabilities remain unknown until a real Phase 2 adapter
can prove them; Phase 1 does not claim local or OS support.

## Stable identity vs replaceable model

“Muse QA Agent” is the stable product identity. “Muse 1.3 Contributor” is today's
model configuration. When Muse 1.4 ships, only the fixture's `model.modelId`
changes — no domain code, no schema change, no branching. The same holds for
harnesses: swapping `muse-code` for a future harness edits configuration only,
because `ModelDefinition.provider/modelId` and `HarnessDefinition.adapterId` are
open strings (shape-validated, never enumerated).

## Replacement proof

`stack-future.json` (`future-ai / future-model-v9` + `future-harness`) validates
through the unchanged `AgentStackDefinitionSchema`, and the agent-stack test pins
this: unknown future providers and adapter IDs are accepted; hard-coded model
unions are forbidden by design and by test.

## Identity policy

Runtime-generated entities use opaque, sortable ULID-shaped IDs. Agent Stack IDs
are configuration keys, so validated stable human-authored forms such as
`stack_muse_main` are deliberately allowed. This exception applies only to
AgentStack IDs; it does not loosen any runtime entity ID schema.

## Traceability

`AgentRun.runtimeIdentity` records the exact model/harness/adapter/policy versions
that produced each Finding, so agent-performance analytics can later answer
“which exact stack produced this claim?” without guessing from display names.

## Independent execution

Each selected stack receives one private `HarnessRunRequest` and an isolated,
writable workspace derived from the locked baseline. The request cannot expose
other selected agents, their plans, findings, evidence, or progress. Each agent
creates an immutable initial investigation plan and may later emit separate
emergent hypotheses. Plan targets have no priority field that permits relevant
areas to be skipped.
