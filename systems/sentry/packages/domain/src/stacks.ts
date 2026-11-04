/**
 * Initial Agent Stack fixtures (configuration only — no domain branching
 * on these values anywhere). Stable product identity (displayName) is
 * separate from the replaceable model + harness configuration.
 */
import { AgentStackDefinitionSchema, type AgentStackDefinition } from '@qa/schemas';

export const DEEPSEEK_QA_STACK = AgentStackDefinitionSchema.parse({
  schemaVersion: 1,
  id: 'stack_deepseek_main',
  displayName: 'DeepSeek QA Agent',
  enabled: true,
  model: { provider: 'deepseek', modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
  harness: { adapterId: 'deepseek-harness', expectedProtocolVersion: 1 },
  execution: {},
  policy: { id: 'qa-standard', version: 1 },
});

export const GLM_QA_STACK = AgentStackDefinitionSchema.parse({
  schemaVersion: 1,
  id: 'stack_glm_main',
  displayName: 'GLM QA Agent',
  enabled: true,
  model: { provider: 'zai', modelId: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash' },
  harness: { adapterId: 'claude-code', expectedProtocolVersion: 1 },
  execution: {},
  policy: { id: 'qa-standard', version: 1 },
});

/** Fictional future stack proving model/harness replaceability (must validate unchanged). */
export const FUTURE_QA_STACK = AgentStackDefinitionSchema.parse({
  schemaVersion: 1,
  id: 'stack_future_main',
  displayName: 'Future QA Agent',
  enabled: true,
  model: { provider: 'future-ai', modelId: 'future-model-v9' },
  harness: { adapterId: 'future-harness', expectedProtocolVersion: 1 },
  execution: {},
  policy: { id: 'qa-standard', version: 1 },
});

// Historical note: 'stack_muse_main' (Muse QA Agent, adapter 'muse-code') was an
// active stack until the Muse → OpenCode migration. It is intentionally absent
// from this active catalog. Persisted historical rows referencing the old stack
// remain decodable via @qa/schemas (no active-stack membership check exists
// on stored runs) and must never be rewritten to a new stack id.
//
// OpenCode is the HARNESS, OpenRouter is the PROVIDER, and the configured
// model is the MODEL: three separate concepts (see docs/adr/0014-*). The
// stack pins harness=openrouter-capable 'opencode'; provider/model resolve
// at preflight from SENTRY_OPENCODE_MODEL (+ optional SENTRY_OPENCODE_PROVIDER).
export const OPENCODE_QA_STACK = AgentStackDefinitionSchema.parse({
  schemaVersion: 1,
  id: 'stack_opencode_main',
  displayName: 'OpenCode QA Agent',
  enabled: true,
  model: {
    provider: 'openrouter',
    modelId: 'unconfigured',
    displayName: 'OpenRouter model',
  },
  harness: { adapterId: 'opencode', expectedProtocolVersion: 1 },
  execution: {},
  policy: { id: 'qa-standard', version: 1 },
});

export const INITIAL_AGENT_STACKS: readonly AgentStackDefinition[] = [
  OPENCODE_QA_STACK,
  DEEPSEEK_QA_STACK,
  GLM_QA_STACK,
];
