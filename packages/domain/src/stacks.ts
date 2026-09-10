/**
 * Initial Agent Stack fixtures (configuration only — no domain branching
 * on these values anywhere). Stable product identity (displayName) is
 * separate from the replaceable model + harness configuration.
 */
import { AgentStackDefinitionSchema, type AgentStackDefinition } from '@qa/schemas';

export const MUSE_QA_STACK = AgentStackDefinitionSchema.parse({
  schemaVersion: 1,
  id: 'stack_muse_main',
  displayName: 'Muse QA Agent',
  enabled: true,
  model: { provider: 'meta', modelId: 'muse-1.3-contributor', displayName: 'Muse 1.3 Contributor' },
  harness: { adapterId: 'muse-code', expectedProtocolVersion: 1 },
  execution: {},
  policy: { id: 'qa-standard', version: 1 },
});

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

export const INITIAL_AGENT_STACKS: readonly AgentStackDefinition[] = [
  MUSE_QA_STACK,
  DEEPSEEK_QA_STACK,
  GLM_QA_STACK,
];
