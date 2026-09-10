import { rm } from 'node:fs/promises';
import type { AgentRunId, ProjectId, QARunId, SnapshotId } from '@qa/shared';
import type { HarnessWorkspace } from '@qa/schemas';
import { agentWorkspacePath, copyTree, resolveInside, type CopyProgress } from '@qa/persistence';

export interface CreateWorkspaceInput {
  readonly projectId: ProjectId;
  readonly qaRunId: QARunId;
  readonly agentRunId: AgentRunId;
  readonly snapshotId: SnapshotId;
  readonly workingCopyPath: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CopyProgress) => void;
}

export interface CleanupResult {
  readonly cleaned: boolean;
  readonly warning?: string;
}

export class WorkspaceFactory {
  constructor(
    private readonly dataRoot: string,
    private readonly keepWorkspaces = process.env['SENTRY_KEEP_WORKSPACES'] === '1',
  ) {}

  async create(input: CreateWorkspaceInput): Promise<HarnessWorkspace> {
    const runtimePath = agentWorkspacePath(
      this.dataRoot,
      input.projectId,
      input.qaRunId,
      input.agentRunId,
    );
    await rm(runtimePath, { recursive: true, force: true });
    await copyTree(input.workingCopyPath, runtimePath, {
      preferReflink: true,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    return { runtimePath, snapshotId: input.snapshotId, writable: true, isolated: true };
  }

  async cleanup(workspace: HarnessWorkspace): Promise<CleanupResult> {
    if (this.keepWorkspaces)
      return { cleaned: false, warning: 'Workspace retained by configuration' };
    try {
      const safePath = resolveInside(this.dataRoot, workspace.runtimePath);
      await rm(safePath, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 50,
      });
      return { cleaned: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { cleaned: false, warning: 'Workspace cleanup failed: ' + message };
    }
  }
}
