import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { DeepSeekHarnessAdapter, type DeepSeekHarnessAdapterOptions } from './adapter.js';
import { probeDeepSeekExecutable, resolveDeepSeekRuntime } from './discovery.js';
import { DEEPSEEK_SDK_VERSION } from './sdk.js';

export function createDeepSeekRegistration(
  options: DeepSeekHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  const runtime = resolveDeepSeekRuntime(options);
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_deepseek_main',
    displayName: 'DeepSeek QA Agent',
    enabled: true,
    model: {
      provider: 'deepseek',
      modelId: runtime.modelId,
      displayName: 'DeepSeek V4 Flash',
    },
    harness: { adapterId: 'deepseek-harness', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    modelId: runtime.modelId,
    adapterId: 'deepseek-harness',
    adapterVersion: '0.1.0',
    sdkVersion: DEEPSEEK_SDK_VERSION,
    executable: runtime.executable,
  };
  return {
    stack,
    preflight: async () => {
      runtimeIdentity.executableVersion = await probeDeepSeekExecutable(
        runtime.executable,
        options.environment ?? process.env,
      );
    },
    createAdapter: () =>
      new DeepSeekHarnessAdapter({
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
