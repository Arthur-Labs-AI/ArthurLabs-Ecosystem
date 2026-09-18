import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { ClaudeCodeHarnessAdapter, type ClaudeCodeHarnessAdapterOptions } from './adapter.js';
import {
  assertGlmAuthConfigured,
  assertGlmEndpointConfigured,
  probeClaudeExecutable,
  resolveGlmRuntime,
} from './discovery.js';
import { CLAUDE_CODE_VERSION } from './sdk.js';

export function createGlmRegistration(
  options: ClaudeCodeHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  // Runtime config resolves lazily so registering an unselected stack
  // never throws: only the selected stacks' preflight/adapter paths report
  // GLM_MODEL_NOT_CONFIGURED.
  let runtime: { modelId: string; executable: string } | undefined;
  const resolveRuntime = () => (runtime ??= resolveGlmRuntime(options));
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_glm_main',
    displayName: 'GLM QA Agent',
    enabled: true,
    // Placeholder until preflight resolves the real model: the stack
    // definition requires a non-empty modelId, and the authoritative
    // configured value is reported by preflight/runtimeIdentity.
    model: {
      provider: 'zai-anthropic',
      modelId: 'unconfigured',
      displayName: 'GLM-5.3-Flash',
    },
    harness: { adapterId: 'claude-code', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    adapterId: 'claude-code',
    adapterVersion: '0.1.0',
    sdkVersion: CLAUDE_CODE_VERSION,
  };
  return {
    stack,
    preflight: async () => {
      const resolved = resolveRuntime();
      assertGlmEndpointConfigured(options.environment ?? process.env);
      assertGlmAuthConfigured(options.environment ?? process.env);
      runtimeIdentity.modelId = resolved.modelId;
      runtimeIdentity.executable = resolved.executable;
      runtimeIdentity.executableVersion = await probeClaudeExecutable(
        resolved.executable,
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
