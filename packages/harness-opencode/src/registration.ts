import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { OpenCodeHarnessAdapter, type OpenCodeHarnessAdapterOptions } from './adapter.js';
import {
  OPENCODE_TESTED_VERSION,
  openRouterCredentialPresent,
  probeOpenCodeExecutable,
  resolveOpenCodeRuntime,
} from './discovery.js';
import { OpenCodeHarnessError } from './errors.js';

export function createOpenCodeRegistration(
  options: OpenCodeHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  // Runtime config resolves lazily so registering an unselected stack
  // never throws: only the selected stacks' preflight/adapter paths report
  // OPENCODE_MODEL_NOT_CONFIGURED / OPENCODE_CREDENTIAL_MISSING.
  let runtime: { effectiveModelId: string; provider: string; executable: string } | undefined;
  const resolveRuntime = () => (runtime ??= resolveOpenCodeRuntime(options));
  const stack = AgentStackDefinitionSchema.parse({
    schemaVersion: 1,
    id: 'stack_opencode_main',
    displayName: 'OpenCode QA Agent',
    enabled: true,
    // Placeholder until preflight resolves the real model: the stack
    // definition requires a non-empty modelId, and the authoritative
    // configured value is reported by preflight/runtimeIdentity.
    model: {
      provider: 'openrouter',
      modelId: 'unconfigured',
      displayName: 'OpenRouter model',
    },
    harness: { adapterId: 'opencode', expectedProtocolVersion: 1 },
    execution: { supportsLocalExecution: true },
    policy: { id: 'qa-standard', version: 1 },
  });
  const runtimeIdentity: Partial<AgentRuntimeIdentity> = {
    adapterId: 'opencode',
    adapterVersion: '0.1.0',
    sdkVersion: OPENCODE_TESTED_VERSION,
  };
  return {
    stack,
    preflight: async () => {
      const resolved = resolveRuntime();
      if (!openRouterCredentialPresent(options.environment ?? process.env)) {
        throw new OpenCodeHarnessError(
          'OPENCODE_CREDENTIAL_MISSING',
          'OpenCode credential is missing. Set OPENROUTER_API_KEY.',
        );
      }
      // Truthful identity: the EFFECTIVE OpenCode model id (what --model
      // receives) plus the provider it was composed with.
      runtimeIdentity.modelId = resolved.effectiveModelId;
      runtimeIdentity.provider = resolved.provider;
      runtimeIdentity.executable = resolved.executable;
      runtimeIdentity.executableVersion = await probeOpenCodeExecutable(
        resolved.executable,
        options.environment ?? process.env,
      );
    },
    createAdapter: () =>
      new OpenCodeHarnessAdapter({
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
