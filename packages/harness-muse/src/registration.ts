import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { MuseHarnessAdapter, type MuseHarnessAdapterOptions } from './adapter.js';
import { probeMuseExecutable, resolveMuseRuntime } from './discovery.js';
import { MUSE_SDK_VERSION } from './sdk.js';

export function createMuseRegistration(
  options: MuseHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  // Runtime config resolves lazily so registering an unselected stack never
  // throws: only the selected stacks' preflight/adapter paths report
  // MUSE_MODEL_NOT_CONFIGURED.
  let runtime: { modelId: string; executable: string } | undefined;
  const resolveRuntime = () => (runtime ??= resolveMuseRuntime(options));
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_muse_main',
    displayName: 'Muse QA Agent',
    enabled: true,
    // Placeholder until preflight resolves the real model: the stack
    // definition requires a non-empty modelId, and the authoritative
    // configured value is reported by preflight/runtimeIdentity.
    model: { provider: 'meta', modelId: 'unconfigured', displayName: 'Muse 1.3 Contributor' },
    harness: { adapterId: 'muse-code', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    adapterId: 'muse-code',
    adapterVersion: '0.1.0',
    sdkVersion: MUSE_SDK_VERSION,
  };
  return {
    stack,
    preflight: async () => {
      const resolved = resolveRuntime();
      runtimeIdentity.modelId = resolved.modelId;
      runtimeIdentity.executable = resolved.executable;
      runtimeIdentity.executableVersion = await probeMuseExecutable(
        resolved.executable,
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
