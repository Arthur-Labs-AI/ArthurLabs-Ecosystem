import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { DeepSeekHarnessAdapter, type DeepSeekHarnessAdapterOptions } from './adapter.js';
import { probeDeepSeekExecutable, resolveDeepSeekRuntime } from './discovery.js';
import { DEEPSEEK_SDK_VERSION } from './sdk.js';

export function createDeepSeekRegistration(
  options: DeepSeekHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  // Runtime config resolves lazily so registering an unselected stack
  // never throws: only the selected stacks' preflight/adapter paths report
  // DEEPSEEK_MODEL_NOT_CONFIGURED.
  let runtime: { modelId: string; executable: string } | undefined;
  const resolveRuntime = () => (runtime ??= resolveDeepSeekRuntime(options));
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_deepseek_main',
    displayName: 'DeepSeek QA Agent',
    enabled: true,
    // Placeholder until preflight resolves the real model: the stack
    // definition requires a non-empty modelId, and the authoritative
    // configured value is reported by preflight/runtimeIdentity.
    model: {
      provider: 'deepseek',
      modelId: 'unconfigured',
      displayName: 'DeepSeek V4 Flash',
    },
    harness: { adapterId: 'deepseek-harness', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    adapterId: 'deepseek-harness',
    adapterVersion: '0.1.0',
    sdkVersion: DEEPSEEK_SDK_VERSION,
  };
  return {
    stack,
    preflight: async () => {
      const resolved = resolveRuntime();
      runtimeIdentity.modelId = resolved.modelId;
      runtimeIdentity.executable = resolved.executable;
      runtimeIdentity.executableVersion = await probeDeepSeekExecutable(
        resolved.executable,
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
