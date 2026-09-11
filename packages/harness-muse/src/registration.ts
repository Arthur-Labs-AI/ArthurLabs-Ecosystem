import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { MuseHarnessAdapter, type MuseHarnessAdapterOptions } from './adapter.js';
import { probeMuseExecutable, resolveMuseRuntime } from './discovery.js';
import { MUSE_SDK_VERSION } from './sdk.js';

export function createMuseRegistration(
  options: MuseHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  const runtime = resolveMuseRuntime(options);
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_muse_main',
    displayName: 'Muse QA Agent',
    enabled: true,
    model: { provider: 'meta', modelId: runtime.modelId, displayName: 'Muse 1.3 Contributor' },
    harness: { adapterId: 'muse-code', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    modelId: runtime.modelId,
    adapterId: 'muse-code',
    adapterVersion: '0.1.0',
    sdkVersion: MUSE_SDK_VERSION,
    executable: runtime.executable,
  };
  return {
    stack,
    preflight: async () => {
      runtimeIdentity.executableVersion = await probeMuseExecutable(
        runtime.executable,
        options.environment ?? process.env,
      );
    },
    createAdapter: () =>
      new MuseHarnessAdapter({
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
