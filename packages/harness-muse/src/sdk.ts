import { MuseClient, type FoldedItem, type Turn, type TurnOutcome } from '@muse-code/sdk';

export const MUSE_SDK_VERSION = '0.1.1' as const;
export const MUSE_HOST_ARGUMENTS = ['serve'] as const;
export const MUSE_APPROVAL_MODE = 'allowAll' as const;
export type MuseFoldedItem = FoldedItem;
export type MuseTurnOutcome = TurnOutcome;

export interface MuseTurnView {
  readonly items: () => AsyncIterableIterator<FoldedItem>;
  readonly completed: Promise<TurnOutcome>;
}

export interface MuseSessionView {
  sendText(text: string): Promise<MuseTurnView>;
}

export interface MuseClientView {
  readonly serverVersion?: string;
  startSession(input: {
    readonly workspaceRoot: string;
    readonly modelId: string;
  }): Promise<MuseSessionView>;
  close(): Promise<void>;
}

export type MuseClientFactory = (input: {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onStderr: (chunk: string) => void;
  readonly shutdownTimeoutMs: number;
}) => Promise<MuseClientView>;

class ProductionSession implements MuseSessionView {
  constructor(private readonly session: Awaited<ReturnType<MuseClient['startSession']>>) {}

  async sendText(text: string): Promise<Turn> {
    return this.session.sendUserTurn({ input: [{ type: 'text', text }] });
  }
}

export const createProductionMuseClient: MuseClientFactory = async (input) => {
  const client = await MuseClient.spawn({
    museBin: input.executable,
    args: [...MUSE_HOST_ARGUMENTS],
    cwd: input.cwd,
    env: input.environment,
    clientInfo: { name: 'sentry', version: '0.3.0' },
    onStderr: input.onStderr,
    shutdownTimeoutMs: input.shutdownTimeoutMs,
  });
  return {
    serverVersion: client.initializeResult.serverInfo.version,
    startSession: async ({ workspaceRoot, modelId }) =>
      new ProductionSession(
        await client.startSession({
          workspaceRoot,
          modelId,
          providerId: 'meta',
          // Non-interactive approval selection; Muse sandboxing remains enabled by default.
          approvalMode: MUSE_APPROVAL_MODE,
        }),
      ),
    close: () => client.close(),
  };
};
