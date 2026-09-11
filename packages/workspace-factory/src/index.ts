import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AgentRunId, ProjectId, QARunId, SnapshotId } from '@qa/shared';
import type { HarnessWorkspace } from '@qa/schemas';
import { agentWorkspacePath, copyTree, resolveInside, type CopyProgress } from '@qa/persistence';

export const BASELINE_HASHES_FILENAME = 'baseline-hashes.json' as const;

export interface BaselineHashIndexInput {
  readonly snapshotId: SnapshotId;
  /** Baseline content hashes (sha256:...) by workspace-relative path. */
  readonly fileHashByPath: ReadonlyMap<string, string>;
}

export interface CreateWorkspaceInput {
  readonly projectId: ProjectId;
  readonly qaRunId: QARunId;
  readonly agentRunId: AgentRunId;
  readonly snapshotId: SnapshotId;
  readonly workingCopyPath: string;
  /**
   * Authoritative baseline hashes from the frozen run snapshot manifest.
   * Written to Sentry-owned .sentry-workspace/ (outside the agent-visible
   * project tree) so harnesses can classify baseline vs modified_workspace.
   */
  readonly baseline?: BaselineHashIndexInput;
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
    const workspaceRoot = dirname(runtimePath);
    const sentryOwned = resolve(workspaceRoot, '.sentry-workspace');
    await rm(workspaceRoot, { recursive: true, force: true });
    await copyTree(input.workingCopyPath, runtimePath, {
      preferReflink: true,
      symlinkPolicy: 'inert-unsafe',
      blockedLinkMetadataRoot: resolve(sentryOwned, 'blocked-links'),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    if (input.baseline !== undefined) {
      await mkdir(sentryOwned, { recursive: true });
      const files: Record<string, string> = {};
      for (const [relativePath, hash] of input.baseline.fileHashByPath) {
        files[relativePath] = hash;
      }
      await writeFile(
        resolve(sentryOwned, BASELINE_HASHES_FILENAME),
        JSON.stringify({ schemaVersion: 1, snapshotId: input.baseline.snapshotId, files }),
        'utf8',
      );
    }
    return { runtimePath, snapshotId: input.snapshotId, writable: true, isolated: true };
  }

  async cleanup(workspace: HarnessWorkspace): Promise<CleanupResult> {
    if (this.keepWorkspaces)
      return { cleaned: false, warning: 'Workspace retained by configuration' };
    try {
      const safePath = resolveInside(this.dataRoot, workspace.runtimePath);
      const cleanupPath =
        basename(safePath) === 'project' && basename(dirname(safePath)) === 'workspace'
          ? dirname(safePath)
          : safePath;
      await rm(cleanupPath, {
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
