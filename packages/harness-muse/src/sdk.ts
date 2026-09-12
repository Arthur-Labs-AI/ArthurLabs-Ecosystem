import {
  MuseClient,
  type ApprovalDecisionInput,
  type ApprovalHandler,
  type FoldedItem,
  type Turn,
  type TurnOutcome,
} from '@muse-code/sdk';

type ApprovalRequest = Parameters<ApprovalHandler>[0];

export const MUSE_SDK_VERSION = '0.1.1' as const;
export const MUSE_HOST_ARGUMENTS = ['serve'] as const;
export const MUSE_APPROVAL_MODE = 'allowAll' as const;
export type MuseFoldedItem = FoldedItem;
export type MuseTurnOutcome = TurnOutcome;

export interface MuseTurnView {
  readonly items: () => AsyncIterableIterator<FoldedItem>;
  readonly completed: Promise<TurnOutcome>;
}

export interface MuseApprovalDecision {
  readonly approvalId: string;
  readonly toolName: string;
  readonly choiceId: string;
  readonly approved: boolean;
  readonly reason: string;
}

export interface MuseSessionView {
  sendText(text: string): Promise<MuseTurnView>;
  /** Approval decisions made by the workspace-scoped auto-decider. */
  drainApprovalDecisions(): readonly MuseApprovalDecision[];
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

/**
 * Non-interactive approval policy for the isolated QA worker.
 *
 * The host parks tool calls it cannot auto-resolve as `human_pending` and
 * waits forever without a decision (observed live: a `vitest run | head`
 * pipeline parked the whole session). Sentry answers every request itself:
 *
 * - APPROVE (server-offered allow choice) only workspace-contained subjects:
 *   shell/file/process/tool subjects whose workspaceRoot sits inside the
 *   Sentry workspace, with no network subject and no protected-write or
 *   judge-escalated flags.
 * - Otherwise select the server-offered abort choice so the turn completes
 *   and the limitation is recorded instead of hanging forever.
 *
 * This selects an approval policy; it never disables sandboxing. The host
 * enforces its sandbox on every approved command. Choice IDs always come
 * from the request's own availableChoices (select-never-create).
 */
export function decideMuseApproval(
  request: ApprovalRequest,
  workspaceRoot: string,
): ApprovalDecisionInput & { readonly approved: boolean; readonly reason: string } {
  const choices = request.availableChoices ?? [];
  const allowChoice = choices.find(
    (choice: { choiceId: string; label: string }) =>
      /allow/i.test(choice.choiceId) || /allow/i.test(choice.label),
  );
  const abortChoice = choices.find((choice: { choiceId: string }) =>
    /abort|deny|reject/i.test(choice.choiceId),
  );
  const deny = (reason: string) => ({
    ...(abortChoice === undefined
      ? { choiceId: choices[0]?.choiceId ?? 'abort', feedback: null }
      : { choiceId: abortChoice.choiceId, feedback: null }),
    approved: false as const,
    reason,
  });
  const subject = (request.subject ?? {}) as {
    kind?: unknown;
    workspaceRoot?: unknown;
    host?: unknown;
    port?: unknown;
    protocol?: unknown;
  };
  const normalizedWorkspace = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const subjectRoot =
    typeof subject.workspaceRoot === 'string'
      ? subject.workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')
      : undefined;
  if (request.protectedWrite === true)
    return deny('protected-write subjects are never auto-approved');
  if (request.judgeEscalated === true)
    return deny('judge-escalated subjects are never auto-approved');
  if (typeof subject.kind === 'string' && subject.kind.toLowerCase().includes('network'))
    return deny('network subjects are never auto-approved');
  if (subject.host !== undefined || subject.port !== undefined || subject.protocol !== undefined)
    return deny('subjects with network endpoints are never auto-approved');
  if (subjectRoot !== undefined) {
    const inside =
      subjectRoot === normalizedWorkspace || subjectRoot.startsWith(normalizedWorkspace + '/');
    if (!inside) return deny('subject workspace is outside the isolated Sentry workspace');
  }
  if (allowChoice === undefined) return deny('no server-offered allow choice');
  return {
    choiceId: allowChoice.choiceId,
    feedback: null,
    approved: true as const,
    reason: 'workspace-contained subject auto-approved',
  };
}

class ProductionSession implements MuseSessionView {
  private readonly decisions: MuseApprovalDecision[] = [];

  constructor(
    private readonly session: Awaited<ReturnType<MuseClient['startSession']>>,
    private readonly workspaceRoot: string,
  ) {
    const inner = this.session as unknown as {
      onApproval?: (handler: ApprovalHandler) => void;
      onApprovalError?: (handler: (failure: unknown) => void) => void;
    };
    inner.onApproval?.((request: ApprovalRequest) => {
      const verdict = decideMuseApproval(request, this.workspaceRoot);
      this.decisions.push({
        approvalId: request.approvalId,
        toolName: request.toolName,
        choiceId: verdict.choiceId,
        approved: verdict.approved,
        reason: verdict.reason,
      });
      return { choiceId: verdict.choiceId, feedback: verdict.feedback ?? null };
    });
    inner.onApprovalError?.((failure) => {
      this.decisions.push({
        approvalId: 'unknown',
        toolName: 'unknown',
        choiceId: 'error',
        approved: false,
        reason: 'approval round trip failed: ' + String(failure).slice(0, 300),
      });
    });
  }

  async sendText(text: string): Promise<Turn> {
    return this.session.sendUserTurn({ input: [{ type: 'text', text }] });
  }

  drainApprovalDecisions(): readonly MuseApprovalDecision[] {
    return this.decisions.splice(0);
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
        workspaceRoot,
      ),
    close: () => client.close(),
  };
};
