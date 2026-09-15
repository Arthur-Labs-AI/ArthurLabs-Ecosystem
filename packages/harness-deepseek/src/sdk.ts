import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client';

export const DEEPSEEK_SDK_VERSION = '0.1.5-rc.2' as const;
export const DEEPSEEK_RUNTIME_PROFILE = 'sdk-minimal' as const;
export type DeepSeekRunResult = RunResult;

export interface DeepSeekSessionView {
  runText(text: string, sessionId?: string): Promise<RunResult>;
}

export interface DeepSeekClientView {
  readonly runtimeVersion?: string;
  start(): Promise<void>;
  startSession(input?: { readonly sessionId?: string }): Promise<DeepSeekSessionView>;
  close(): Promise<void>;
}

export type DeepSeekClientFactory = (input: {
  readonly executable?: string;
  readonly cwd: string;
  readonly dshHome: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelId: string;
  readonly provider: string;
  readonly profilePatches: readonly string[];
  readonly initializeTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}) => Promise<DeepSeekClientView>;

interface ProductionHarnessView {
  start(): Promise<void>;
  run(text: string, options: { readonly sessionId: string }): Promise<RunResult>;
  close(): Promise<void>;
}

class ProductionSession implements DeepSeekSessionView {
  constructor(
    private readonly harness: ProductionHarnessView,
    private readonly sessionId: string,
  ) {}

  async runText(text: string, sessionId?: string): Promise<RunResult> {
    return this.harness.run(text, { sessionId: sessionId ?? this.sessionId });
  }
}

export function createDeepSeekClientFromHarness(
  harness: ProductionHarnessView,
): DeepSeekClientView {
  return {
    start: () => harness.start(),
    startSession: async (input = {}) =>
      new ProductionSession(harness, input.sessionId ?? 'sentry-' + Date.now().toString(36)),
    close: () => harness.close(),
  };
}

export const createProductionDeepSeekClient: DeepSeekClientFactory = async (input) => {
  const explicitBin =
    input.executable !== undefined &&
    (input.executable.includes('/') || input.executable.includes('\\'))
      ? input.executable
      : undefined;
  const options: DeepSeekHarnessOptions = {
    profile: DEEPSEEK_RUNTIME_PROFILE,
    patches: [...input.profilePatches],
    provider: input.provider,
    model: input.modelId,
    cwd: input.cwd,
    dshHome: input.dshHome,
    processCwd: input.cwd,
    env: input.environment,
    initializeTimeoutMs: input.initializeTimeoutMs,
    shutdownTimeoutMs: input.shutdownTimeoutMs,
    // Only an explicit filesystem path overrides the client's own
    // same-version runtime resolution; a bare 'dsh' name stays resolved
    // by the client package itself.
    ...(explicitBin === undefined ? {} : { dshBin: explicitBin }),
  };
  const harness = new DeepSeekHarness(options);
  return createDeepSeekClientFromHarness(harness);
};
