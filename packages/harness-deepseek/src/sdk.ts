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

/**
 * DeepSeek executable vs DSH runtime entrypoint.
 *
 * `input.executable` names the DeepSeek *executable / CLI wrapper*: either
 * a bare name resolved from PATH (`dsh`) or an absolute wrapper such as
 * Sentry's managed `.../tools/deepseek/bin/dsh` (a Bash script used for
 * `--version` probes, launcher diagnostics, and `runtime/current`
 * tracking). It is executed directly, never through Node.
 *
 * The vendor SDK's `DeepSeekHarnessOptions.dshBin`, by contrast, is always
 * launched as `node <dshBin>` (see `resolveDshLaunch` in
 * `@deepseek-ai/dsh-sdk-client`). Only a genuine Node-launchable DSH
 * JavaScript runtime entrypoint (`.js`/`.mjs`/`.cjs`) may be passed there —
 * never a shell wrapper. When the configured executable is not such an
 * entrypoint, `dshBin` is omitted so the SDK resolves and launches its own
 * pinned compatible DSH runtime instead of running `node <bash-wrapper>`.
 *
 * This mirrors `probeDeepSeekExecutable()` in `discovery.ts`, which likewise
 * treats only `.js/.mjs/.cjs` paths as Node scripts.
 */
export function resolveExplicitDshEntry(executable: string | undefined): string | undefined {
  if (executable === undefined) return undefined;
  return /\.[cm]?js$/i.test(executable) ? executable : undefined;
}

export const createProductionDeepSeekClient: DeepSeekClientFactory = async (input) => {
  const explicitDshEntry = resolveExplicitDshEntry(input.executable);
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
    // Only a real JS DSH runtime entrypoint overrides the client's own
    // same-version runtime resolution. A bare 'dsh' name or a shell wrapper
    // (e.g. Sentry's managed bin/dsh) stays resolved by the client package
    // itself — passing a wrapper here would make the SDK run
    // `node <bash-wrapper>` and fail at startup.
    ...(explicitDshEntry === undefined ? {} : { dshBin: explicitDshEntry }),
  };
  const harness = new DeepSeekHarness(options);
  return createDeepSeekClientFromHarness(harness);
};
