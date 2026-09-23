# Agent Stack

```text
AgentStack = Model + Harness + Execution Requirements + QA Policy
           + optional ExecutionSafeguards
```

The stack is the unit the QA Core schedules: one `AgentRun` = one stack × one
task inside one `QARun`. The domain reasons about stacks generically — there is
no `if (model === 'opencode')` anywhere; vendor specifics belong in adapters.

`ExecutionSafeguards` contains operational controls only: `runTimeoutMs` and
`commandTimeoutMs`. They are process safety boundaries, not product quotas.
Turn, token, and monetary limits are deliberately absent.

## Today's configurations (fixtures, not product constants)

- **OpenCode QA Agent** = configured OpenRouter model (`provider: openrouter`) +
  OpenCode (`adapterId: opencode`) — `stack_opencode_main`
- **DeepSeek QA Agent** = DeepSeek V4 Flash (`provider: deepseek`) + DeepSeek
  Harness (`adapterId: deepseek-harness`) — `stack_deepseek_main`
- **GLM QA Agent** = GLM-5.3-Flash (`provider: zai`) + Claude Code
  (`adapterId: claude-code`) — `stack_glm_main`

Each fixture carries `policy: qa-standard v1`, `execution: {}`, and protocol v1
expectations. Execution capabilities remain unknown until a real Phase 2 adapter
can prove them; Phase 1 does not claim local or OS support.

## Stable identity vs replaceable model

“OpenCode QA Agent” is the stable product identity. The configured OpenRouter
model is today's model configuration: changing it edits configuration only —
no domain code, no schema change, no branching. The same holds for harnesses:
`ModelDefinition.provider/modelId` and `HarnessDefinition.adapterId` are open
strings (shape-validated, never enumerated). Historical note: the first stack
was “Muse QA Agent” (`stack_muse_main`, adapter `muse-code`); old rows stay
readable and are never rewritten to the new stack id.

## Replacement proof

`stack-future.json` (`future-ai / future-model-v9` + `future-harness`) validates
through the unchanged `AgentStackDefinitionSchema`, and the agent-stack test pins
this: unknown future providers and adapter IDs are accepted; hard-coded model
unions are forbidden by design and by test.

## Identity policy

Runtime-generated entities use opaque, sortable ULID-shaped IDs. Agent Stack IDs
are configuration keys, so validated stable human-authored forms such as
`stack_opencode_main` are deliberately allowed. This exception applies only to
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
