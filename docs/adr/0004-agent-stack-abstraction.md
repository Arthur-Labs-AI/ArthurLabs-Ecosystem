# ADR-0004: AgentStack = Model + Harness + Execution + Policy (not model-only)

Status: accepted

## Context

A model-only architecture (`if model === 'muse' …`) would hard-code today's three
vendors into the core and make harness swaps (Muse Code → successor, new DeepSeek
harness, OpenCode, Kimi) invasive.

## Decision

Model the schedulable unit as an Agent Stack: open-ended ModelDefinition +
HarnessDefinition (adapterId + expectedProtocolVersion) + ExecutionRequirements +
QAPolicyReference + limits. Stable product identities (“Muse QA Agent”) are
configuration; model versions and harnesses are replaceable fields.

## Consequences

Replacements are config edits, proven by the future-agent fixture/test. Cost: the
core must stay generic — any vendor-specific need goes to adapter extensions.
