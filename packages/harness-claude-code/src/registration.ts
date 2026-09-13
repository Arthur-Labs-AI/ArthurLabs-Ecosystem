import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { ClaudeCodeHarnessAdapter, type ClaudeCodeHarnessAdapterOptions } from './adapter.js';
import { probeClaudeExecutable, resolveGlmRuntime } from './discovery.js';
import { CLAUDE_CODE_VERSION } from './sdk.js';

export function createGlmRegistration(
  options: ClaudeCodeHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  const runtime = resolveGlmRuntime(options);
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_glm_main',
    displayName: 'GLM QA Agent',
    enabled: true,
    model: {
      provider: 'zai-anthropic',
      modelId: runtime.modelId,
      displayName: 'GLM-5.3-Flash',
    },
    harness: { adapterId: 'claude-code', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    modelId: runtime.modelId,
    adapterId: 'claude-code',
    adapterVersion: '0.1.0',
    sdkVersion: CLAUDE_CODE_VERSION,
    executable: runtime.executable,
  };
  return {
    stack,
    preflight: async () => {
      runtimeIdentity.executableVersion = await probeClaudeExecutable(
        runtime.executable,
        options.environment ?? process.env,
      );
    },
    createAdapter: () =>
      new ClaudeCodeHarnessAdapter({
        ...options,
        onRuntimeIdentity: (identity) => {
          if (identity.harnessVersion !== undefined)
            runtimeIdentity.harnessVersion = identity.harnessVersion;
          if (identity.executableVersion !== undefined)
            runtimeIdentity.executableVersion = identity.executableVersion;
          options.onRuntimeIdentity?.(identity);
        },
      }),
    runtimeIdentity,
  };
}
