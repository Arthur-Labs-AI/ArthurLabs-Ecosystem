import { basename, dirname, resolve } from 'node:path';
import { access, constants, mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import {
  createProjectId,
  createProjectRevisionId,
  nowIsoTimestamp,
  type ProjectId,
  type QARunId,
} from '@qa/shared';
import {
  ManagedProjectCopySchema,
  ProjectRevisionSchema,
  ProjectSchema,
  type ManagedProjectCopy,
  type Project,
  type ProjectContextSnapshot,
  type ProjectRevision,
} from '@qa/schemas';
import {
  assertNoPathOverlap,
  copyTree,
  estimateTree,
  projectDataPaths,
  type CopyProgress,
  type SentryRepository,
} from '@qa/persistence';
import { SnapshotEngine } from '@qa/snapshot-engine';
import { ProjectContextBuilder } from '@qa/context-builder';
import { ProjectManagerError } from './errors.js';

export interface ProjectRecord {
  readonly project: Project;
  readonly managedCopy: ManagedProjectCopy;
  readonly revision: ProjectRevision;
  readonly context?: ProjectContextSnapshot;
}

export interface ProjectOperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CopyProgress) => void;
}

async function validateSource(sourcePath: string): Promise<string> {
  const source = resolve(sourcePath);
  let sourceStat;
  try {
    sourceStat = await stat(source);
    await access(source, constants.R_OK);
  } catch (cause) {
    throw new ProjectManagerError(
      'PROJECT_SOURCE_NOT_FOUND',
      'Project source is not readable: ' + source,
      {
        cause,
      },
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new ProjectManagerError(
      'PROJECT_SOURCE_UNREADABLE',
      'Project source must be a directory: ' + source,
    );
  }
  return source;
}

export class ProjectManager {
  private readonly snapshots: SnapshotEngine;
  private readonly contexts: ProjectContextBuilder;

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
  ) {
    this.snapshots = new SnapshotEngine(dataRoot, repository);
    this.contexts = new ProjectContextBuilder(dataRoot, repository);
  }

  async addProject(
    sourcePath: string,
    options: ProjectOperationOptions = {},
  ): Promise<ProjectRecord> {
    const source = await validateSource(sourcePath);
    try {
      await assertNoPathOverlap(source, this.dataRoot);
    } catch (cause) {
      throw new ProjectManagerError(
        'PROJECT_PATH_OVERLAP',
        'Project source overlaps the Sentry data root',
        { cause },
      );
    }
    const projectId = createProjectId();
    const revisionId = createProjectRevisionId();
    const paths = projectDataPaths(this.dataRoot, projectId);
    const staging = resolve(paths.staging, 'import-' + revisionId);
    const timestamp = nowIsoTimestamp();
    try {
      await this.preflightStorage(source, dirname(this.dataRoot), options.signal);
      await mkdir(paths.root, { recursive: true });
      const stats = await copyTree(source, staging, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      const scan = await this.snapshots.scanRevision(staging, options.signal);
      await rename(staging, paths.workingCopy);
      const project = ProjectSchema.parse({
        schemaVersion: 1,
        id: projectId,
        name: basename(source),
        sourcePath: source,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      });
      const revision = ProjectRevisionSchema.parse({
        schemaVersion: 1,
        id: revisionId,
        projectId,
        sourcePath: source,
        importedAt: timestamp,
        contentHash: scan.contentHash,
        stats: {
          fileCount: stats.fileCount,
          directoryCount: stats.directoryCount,
          totalBytes: stats.totalBytes,
        },
      });
      const managedCopy = ManagedProjectCopySchema.parse({
        schemaVersion: 1,
        projectId,
        currentRevisionId: revisionId,
        state: 'ready',
        updatedAt: timestamp,
      });
      this.repository.transaction(() => {
        this.repository.saveProject(project);
        this.repository.saveRevision(revision);
        this.repository.saveManagedCopy(managedCopy);
      });
      const context = await this.contexts.build({
        projectId,
        projectRevisionId: revisionId,
        workingCopyPath: paths.workingCopy,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { project, managedCopy, revision, context };
    } catch (cause) {
      try {
        this.repository.deleteProject(projectId);
      } catch {
        // Preserve the original import failure; startup/manual cleanup can remove orphan staging.
      }
      await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
      if (cause instanceof ProjectManagerError) throw cause;
      throw new ProjectManagerError(
        'PROJECT_COPY_FAILED',
        'Failed to create the managed project copy',
        { cause },
      );
    }
  }

  getProject(projectId: ProjectId): ProjectRecord | undefined {
    const project = this.repository.getProject(projectId);
    const managedCopy = this.repository.getManagedCopy(projectId);
    if (project === undefined || managedCopy?.currentRevisionId === undefined) return undefined;
    const revision = this.repository.getRevision(managedCopy.currentRevisionId);
    if (revision === undefined) return undefined;
    const context = this.repository.getContextForRevision(revision.id);
    return { project, managedCopy, revision, ...(context === undefined ? {} : { context }) };
  }

  listProjects(): ProjectRecord[] {
    return this.repository.listProjects().flatMap((project) => {
      const record = this.getProject(project.id);
      return record === undefined ? [] : [record];
    });
  }

  getManagedCopy(projectId: ProjectId): ManagedProjectCopy {
    const copy = this.repository.getManagedCopy(projectId);
    if (copy === undefined)
      throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
    return copy;
  }

  async updateProjectCopy(
    projectId: ProjectId,
    sourcePath?: string,
    options: ProjectOperationOptions = {},
  ): Promise<ProjectRecord> {
    const current = this.getProject(projectId);
    if (current === undefined)
      throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
    if (current.managedCopy.state === 'locked_for_run') {
      throw new ProjectManagerError(
        'PROJECT_LOCKED',
        'Project is locked by active run ' + current.managedCopy.lockedByQARunId,
      );
    }
    const source = await validateSource(sourcePath ?? current.project.sourcePath);
    try {
      await assertNoPathOverlap(source, this.dataRoot);
    } catch (cause) {
      throw new ProjectManagerError(
        'PROJECT_PATH_OVERLAP',
        'Project source overlaps the Sentry data root',
        { cause },
      );
    }
    const paths = projectDataPaths(this.dataRoot, projectId);
    const revisionId = createProjectRevisionId();
    const staging = resolve(paths.staging, 'update-' + revisionId);
    const backup = resolve(paths.root, 'working-copy.backup');
    const timestamp = nowIsoTimestamp();
    const updating = ManagedProjectCopySchema.parse({
      ...current.managedCopy,
      state: 'updating',
      updatedAt: timestamp,
    });
    this.repository.saveManagedCopy(updating);
    let promoted = false;
    try {
      await this.preflightStorage(source, paths.root, options.signal);
      await rm(staging, { recursive: true, force: true });
      const stats = await copyTree(source, staging, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      const scan = await this.snapshots.scanRevision(staging, options.signal);
      const revision = ProjectRevisionSchema.parse({
        schemaVersion: 1,
        id: revisionId,
        projectId,
        sourcePath: source,
        importedAt: timestamp,
        contentHash: scan.contentHash,
        stats: {
          fileCount: stats.fileCount,
          directoryCount: stats.directoryCount,
          totalBytes: stats.totalBytes,
        },
      });
      this.repository.saveRevision(revision);
      const context = await this.contexts.build({
        projectId,
        projectRevisionId: revisionId,
        workingCopyPath: staging,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await rm(backup, { recursive: true, force: true });
      await rename(paths.workingCopy, backup);
      await rename(staging, paths.workingCopy);
      promoted = true;
      const project = ProjectSchema.parse({
        ...current.project,
        sourcePath: source,
        updatedAt: timestamp,
      });
      const managedCopy = ManagedProjectCopySchema.parse({
        ...current.managedCopy,
        currentRevisionId: revisionId,
        state: 'ready',
        updatedAt: timestamp,
      });
      this.repository.transaction(() => {
        this.repository.saveProject(project);
        this.repository.saveManagedCopy(managedCopy);
      });
      // The promoted copy and its database pointer are already durable. A stale
      // backup is preferable to reporting a failed update and rolling them back.
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return { project, managedCopy, revision, context };
    } catch (cause) {
      if (promoted) {
        await rm(paths.workingCopy, { recursive: true, force: true }).catch(() => undefined);
        await rename(backup, paths.workingCopy).catch(() => undefined);
      }
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      this.repository.saveManagedCopy(
        ManagedProjectCopySchema.parse({
          ...current.managedCopy,
          state: 'ready',
          updatedAt: nowIsoTimestamp(),
        }),
      );
      throw new ProjectManagerError(
        'PROJECT_UPDATE_FAILED',
        'Project update failed; previous working copy was preserved',
        { cause },
      );
    }
  }

  lockProjectForRun(projectId: ProjectId, runId: QARunId): ManagedProjectCopy {
    return this.repository.transaction(() => {
      const current = this.getManagedCopy(projectId);
      if (current.state !== 'ready') {
        throw new ProjectManagerError(
          'PROJECT_LOCKED',
          'Project is not ready for a run: ' + current.state,
        );
      }
      const locked = ManagedProjectCopySchema.parse({
        ...current,
        state: 'locked_for_run',
        lockedByQARunId: runId,
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveManagedCopy(locked);
      return locked;
    });
  }

  unlockProjectAfterRun(projectId: ProjectId, runId: QARunId): ManagedProjectCopy {
    return this.repository.transaction(() => {
      const current = this.getManagedCopy(projectId);
      if (current.state !== 'locked_for_run' || current.lockedByQARunId !== runId) {
        throw new ProjectManagerError(
          'PROJECT_LOCKED',
          'Run does not own the managed project lock',
        );
      }
      const ready = ManagedProjectCopySchema.parse({
        schemaVersion: 1,
        projectId,
        currentRevisionId: current.currentRevisionId,
        state: 'ready',
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveManagedCopy(ready);
      return ready;
    });
  }

  async assertWorkingCopyIntegrity(projectId: ProjectId): Promise<ProjectRevision> {
    const current = this.getProject(projectId);
    if (current === undefined)
      throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
    const actual = await this.snapshots.scanRevision(
      projectDataPaths(this.dataRoot, projectId).workingCopy,
    );
    if (actual.contentHash !== current.revision.contentHash) {
      throw new ProjectManagerError(
        'PROJECT_COPY_DRIFT',
        'Managed working copy differs from its recorded revision',
      );
    }
    return current.revision;
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    const copy = this.getManagedCopy(projectId);
    if (copy.state === 'locked_for_run' || copy.state === 'updating') {
      throw new ProjectManagerError('PROJECT_LOCKED', 'Project cannot be deleted while active');
    }
    const paths = projectDataPaths(this.dataRoot, projectId);
    const tombstone = paths.root + '.deleting';
    await rm(tombstone, { recursive: true, force: true });
    await rename(paths.root, tombstone);
    try {
      this.repository.deleteProject(projectId);
      await rm(tombstone, { recursive: true, force: true });
    } catch (cause) {
      await rename(tombstone, paths.root).catch(() => undefined);
      throw new ProjectManagerError('PROJECT_UPDATE_FAILED', 'Project deletion failed', { cause });
    }
  }

  async recoverInterruptedUpdates(): Promise<void> {
    for (const copy of this.repository.listManagedCopiesByState(['updating'])) {
      const paths = projectDataPaths(this.dataRoot, copy.projectId);
      const backup = resolve(paths.root, 'working-copy.backup');
      let backupExists = false;
      try {
        await stat(backup);
        backupExists = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ProjectManagerError(
            'PROJECT_UPDATE_FAILED',
            'Unable to inspect interrupted project update backup',
            { cause },
          );
        }
      }
      try {
        if (backupExists) {
          await rm(paths.workingCopy, { recursive: true, force: true });
          await rename(backup, paths.workingCopy);
        } else {
          // Before promotion begins, the recorded working copy must still exist.
          await stat(paths.workingCopy);
        }
        await rm(paths.staging, { recursive: true, force: true });
        await mkdir(paths.staging, { recursive: true });
      } catch (cause) {
        throw new ProjectManagerError(
          'PROJECT_UPDATE_FAILED',
          'Unable to recover interrupted project update',
          { cause },
        );
      }
      this.repository.saveManagedCopy(
        ManagedProjectCopySchema.parse({
          schemaVersion: 1,
          projectId: copy.projectId,
          currentRevisionId: copy.currentRevisionId,
          state: 'ready',
          updatedAt: nowIsoTimestamp(),
        }),
      );
    }
  }

  private async preflightStorage(
    source: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const estimate = await estimateTree(source, signal);
    try {
      const storage = await statfs(destination);
      const available = storage.bavail * storage.bsize;
      if (estimate.totalBytes > available) {
        throw new ProjectManagerError(
          'INSUFFICIENT_STORAGE',
          'Available destination storage is smaller than the source project',
        );
      }
    } catch (cause) {
      if (cause instanceof ProjectManagerError) throw cause;
      // Portable free-space checks are best-effort; copy errors remain authoritative.
    }
  }
}

export * from './errors.js';
