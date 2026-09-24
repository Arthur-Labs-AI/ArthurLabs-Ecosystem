import { AgentStackDefinitionSchema, type AgentRuntimeIdentity } from '@qa/schemas';
import type { HarnessAdapterRegistration } from '@qa/harness-protocol';
import { OpenCodeHarnessAdapter, type OpenCodeHarnessAdapterOptions } from './adapter.js';
import {
  assertSupportedOpenCodeProvider,
  assertTestedOpenCodeVersion,
  credentialEnvForProvider,
  describeOpenCodeExecutableFailure,
  OPENCODE_TESTED_VERSION,
  openCodeCredentialPresent,
  openCodeSandboxBypassed,
  probeOpenCodeExecutable,
  probeOpenCodeSandbox,
  resolveOpenCodeRuntime,
} from './discovery.js';
import { OpenCodeHarnessError } from './errors.js';

export function createOpenCodeRegistration(
  options: OpenCodeHarnessAdapterOptions = {},
): HarnessAdapterRegistration {
  // Runtime config resolves lazily so registering an unselected stack
  // never throws: only the selected stacks' preflight/adapter paths report
  // OPENCODE_MODEL_NOT_CONFIGURED / OPENCODE_CREDENTIAL_MISSING.
  // Deliberately NOT memoized: runtime.configure can change the binary
  // override after startup, and the next preflight must observe it without
  // a process restart.
  const resolveRuntime = () => resolveOpenCodeRuntime(options);
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
      assertSupportedOpenCodeProvider(resolved.provider, options.providerBaseUrl !== undefined);
      if (!openCodeCredentialPresent(resolved.provider, options.environment ?? process.env)) {
        throw new OpenCodeHarnessError(
          'OPENCODE_CREDENTIAL_MISSING',
          'OpenCode credential is missing. Set ' +
            credentialEnvForProvider(resolved.provider) +
            ' for provider ' +
            resolved.provider +
            '.',
        );
      }
      // Truthful identity: the EFFECTIVE OpenCode model id (what --model
      // receives) plus the provider it was composed with.
      runtimeIdentity.modelId = resolved.effectiveModelId;
      runtimeIdentity.provider = resolved.provider;
      runtimeIdentity.executable = resolved.executable;
      const environment = options.environment ?? process.env;
      const executableVersion = await probeOpenCodeExecutable(
        resolved.executable,
        environment,
        describeOpenCodeExecutableFailure({
          environment,
          ...(resolved.managedCandidate === undefined
            ? {}
            : { managedCandidate: resolved.managedCandidate }),
        }),
      );
      runtimeIdentity.executableVersion = executableVersion;
      // Fail closed on unverified wire/security contracts.
      assertTestedOpenCodeVersion(executableVersion, environment);
      // Fail closed on missing OS containment (production Linux).
      // Explicit SENTRY_OPENCODE_ALLOW_DIRECT=1 opts into weaker
      // execution for development/test only.
      if (process.platform === 'linux' && !openCodeSandboxBypassed(environment)) {
        const sandbox = await probeOpenCodeSandbox({ environment });
        if (!sandbox.systemdUser || !sandbox.bubblewrap || !sandbox.masking) {
          throw new OpenCodeHarnessError(
            'OPENCODE_SANDBOX_UNAVAILABLE',
            'OpenCode OS containment unavailable (systemd=' +
              String(sandbox.systemdUser) +
              ' bwrap=' +
              String(sandbox.bubblewrap) +
              ' masking=' +
              String(sandbox.masking) +
              '); refusing production execution.',
          );
        }
      }
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
