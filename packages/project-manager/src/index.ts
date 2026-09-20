import { basename, dirname, resolve } from 'node:path';
import { access, constants, mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import {
  createOperationId,
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
  RuntimeOperationSchema,
  type ManagedProjectCopy,
  type Project,
  type ProjectContextSnapshot,
  type ProjectRevision,
  type RuntimeOperation,
} from '@qa/schemas';
import {
  assertNoPathOverlap,
  copyTree,
  DEFAULT_IMPORT_EXCLUSIONS,
  estimateTree,
  matchImportExclusion,
  projectDataPaths,
  resolveInside,
  RuntimeInstanceLease,
  type CopyProgress,
  type SentryRepository,
} from '@qa/persistence';
import { SnapshotEngine } from '@qa/snapshot-engine';
import { ProjectContextBuilder, type PreparedProjectContext } from '@qa/context-builder';
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
  /** Opt out of the default import exclusion set (copies+hashes everything).
   *  Recorded on the revision via hashVersion absence (legacy version 1). */
  readonly includeAll?: boolean;
}

export type ProjectMutationStage =
  | 'after_context_prepared'
  | 'after_backup_created'
  | 'after_staging_promoted'
  | 'after_database_committed'
  | 'after_delete_marked'
  | 'after_delete_tombstoned'
  | 'after_delete_committed';

export interface ProjectManagerOptions {
  readonly runtimeLease?: RuntimeInstanceLease;
  readonly faultInjector?: (stage: ProjectMutationStage) => void | Promise<void>;
}

/** Immutable revision material root: projects/<project>/revisions/<revisionId>.
 *  Retained post-commit from the working copy (never from staging, so a
 *  failed import/update leaves no orphan material). Absence means the
 *  revision predates material retention (§44) — honestly unavailable,
 *  never fabricated. */
export function revisionMaterialPath(
  dataRoot: string,
  projectId: ProjectId,
  revisionId: string,
): string {
  return resolve(projectDataPaths(dataRoot, projectId).revisions, revisionId);
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

function exclusionPredicate(includeAll?: boolean): ((relativePath: string) => boolean) | undefined {
  if (includeAll === true) return undefined;
  const set = DEFAULT_IMPORT_EXCLUSIONS;
  return (relativePath: string) => matchImportExclusion(relativePath, set);
}

export class ProjectManager {
  private readonly snapshots: SnapshotEngine;
  private readonly contexts: ProjectContextBuilder;

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
    private readonly options: ProjectManagerOptions = {},
  ) {
    this.snapshots = new SnapshotEngine(dataRoot, repository);
    this.contexts = new ProjectContextBuilder(dataRoot, repository);
  }

  private runtimeLease(): RuntimeInstanceLease {
    const lease = this.options.runtimeLease;
    if (lease === undefined) {
      throw new ProjectManagerError(
        'RUNTIME_LEASE_REQUIRED',
        'This project mutation requires an active runtime lease',
      );
    }
    lease.assertHealthy();
    return lease;
  }

  private async fault(stage: ProjectMutationStage): Promise<void> {
    await this.options.faultInjector?.(stage);
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
      await this.preflightStorage(
        source,
        dirname(this.dataRoot),
        options.signal,
        exclusionPredicate(options.includeAll),
      );
      await mkdir(paths.root, { recursive: true });
      const exclude = exclusionPredicate(options.includeAll);
      const stats = await copyTree(source, staging, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(exclude === undefined ? {} : { exclude }),
      });
      const scan = await this.snapshots.scanRevision(staging, options.signal, {
        ...(exclude === undefined ? {} : { exclude }),
      });
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
        ...(exclude === undefined ? {} : { hashVersion: 2 as const }),
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
        ...(exclude === undefined ? {} : { exclude }),
      });
      await this.retainRevisionMaterial(projectId, revisionId, paths.workingCopy);
      await this.validateRetainedMaterial(projectId, revision, paths.workingCopy);
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

  /** Validate retained material (§50): rescan the retained bytes and
   *  compare contentHash with the revision record. Copy completion
   *  alone is never trusted. Throws on mismatch. */
  async validateRetainedMaterial(
    projectId: ProjectId,
    revision: { id: string; contentHash: string },
    workingCopyPath: string,
  ): Promise<void> {
    void workingCopyPath;
    const materialRoot = revisionMaterialPath(this.dataRoot, projectId, revision.id);
    const scan = await this.snapshots.scanRevision(materialRoot);
    if (scan.contentHash !== revision.contentHash) {
      throw new ProjectManagerError(
        'REVISION_MATERIAL_CORRUPT',
        'Retained revision bytes do not match revision ' +
          revision.id +
          ' (expected ' +
          revision.contentHash +
          ', got ' +
          scan.contentHash +
          ')',
      );
    }
  }

  /** Retain immutable revision bytes: copy-once from the working copy
   *  into revisions/<revisionId>. Reflink/COW where the filesystem
   *  supports it, copy fallback otherwise; no mutable hardlinks.
   *  Symlink policy matches agent workspaces (inert-unsafe).
   *  Idempotent: existing material is left untouched. */
  async retainRevisionMaterial(
    projectId: ProjectId,
    revisionId: string,
    workingCopyPath: string,
  ): Promise<string> {
    const materialRoot = revisionMaterialPath(this.dataRoot, projectId, revisionId);
    try {
      await access(materialRoot, constants.F_OK);
      return materialRoot;
    } catch {
      // Absent: materialize below.
    }
    const staging = materialRoot + '.staging-' + revisionId.slice(-6);
    await rm(staging, { recursive: true, force: true });
    try {
      await copyTree(workingCopyPath, staging, {
        preferReflink: true,
        symlinkPolicy: 'inert-unsafe',
        blockedLinkMetadataRoot: resolve(materialRoot + '.blocked-links'),
      });
      await rename(staging, materialRoot);
    } catch (cause) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw cause;
    }
    return materialRoot;
  }

  /** Resolve retained material for a revision, or undefined when the
   *  revision predates retention (§44). Never fabricates bytes. */
  async revisionMaterialRoot(
    projectId: ProjectId,
    revisionId: string,
  ): Promise<string | undefined> {
    const materialRoot = revisionMaterialPath(this.dataRoot, projectId, revisionId);
    try {
      await access(materialRoot, constants.F_OK);
      return materialRoot;
    } catch {
      return undefined;
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
    const lease = this.runtimeLease();
    const paths = projectDataPaths(this.dataRoot, projectId);
    const revisionId = createProjectRevisionId();
    const operationId = createOperationId();
    const staging = resolve(paths.staging, 'update-' + revisionId);
    const backup = resolve(paths.root, 'working-copy.backup');
    const timestamp = nowIsoTimestamp();
    let operation = RuntimeOperationSchema.parse({
      schemaVersion: 1,
      id: operationId,
      projectId,
      runtimeInstanceId: lease.instanceId,
      type: 'project_update',
      stage: 'preparing',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const current = this.repository.transaction(() => {
      const record = this.getProject(projectId);
      if (record === undefined) {
        throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
      }
      if (record.managedCopy.state !== 'ready') {
        throw new ProjectManagerError(
          record.managedCopy.state === 'locked_for_run' ? 'ACTIVE_RUN_EXISTS' : 'PROJECT_LOCKED',
          record.managedCopy.state === 'locked_for_run'
            ? 'Project already has active run ' + record.managedCopy.lockedByQARunId
            : 'Project is busy with ' + record.managedCopy.state,
        );
      }
      this.repository.saveRuntimeOperation(operation);
      this.repository.saveManagedCopy(
        ManagedProjectCopySchema.parse({
          ...record.managedCopy,
          state: 'updating',
          runtimeInstanceId: lease.instanceId,
          updatedAt: timestamp,
        }),
      );
      return record;
    });
    let prepared: PreparedProjectContext | undefined;
    let databaseCommitted = false;
    try {
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
      await this.preflightStorage(
        source,
        paths.root,
        options.signal,
        exclusionPredicate(options.includeAll),
      );
      await rm(staging, { recursive: true, force: true });
      const exclude = exclusionPredicate(options.includeAll);
      const stats = await copyTree(source, staging, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(exclude === undefined ? {} : { exclude }),
      });
      const scan = await this.snapshots.scanRevision(staging, options.signal, {
        ...(exclude === undefined ? {} : { exclude }),
      });
      const revision = ProjectRevisionSchema.parse({
        schemaVersion: 1,
        id: revisionId,
        projectId,
        sourcePath: source,
        importedAt: timestamp,
        contentHash: scan.contentHash,
        ...(exclude === undefined ? {} : { hashVersion: 2 as const }),
        stats: {
          fileCount: stats.fileCount,
          directoryCount: stats.directoryCount,
          totalBytes: stats.totalBytes,
        },
      });
      prepared = await this.contexts.prepare({
        projectId,
        projectRevisionId: revisionId,
        workingCopyPath: staging,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(exclude === undefined ? {} : { exclude }),
      });
      operation = RuntimeOperationSchema.parse({
        ...operation,
        stagedArtifactPath: prepared.materialArtifact.relativeStoragePath,
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveRuntimeOperation(operation);
      await this.fault('after_context_prepared');
      lease.assertHealthy();
      await rm(backup, { recursive: true, force: true });
      await rename(paths.workingCopy, backup);
      operation = RuntimeOperationSchema.parse({
        ...operation,
        stage: 'backup_created',
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveRuntimeOperation(operation);
      await this.fault('after_backup_created');
      await rename(staging, paths.workingCopy);
      operation = RuntimeOperationSchema.parse({
        ...operation,
        stage: 'promoted',
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveRuntimeOperation(operation);
      await this.fault('after_staging_promoted');
      lease.assertHealthy();
      // Atomic retention (§47): immutable material B is retained and
      // hash-validated BEFORE the DB commits currentRevisionId = B.
      // Retention failure throws here → catch restores working A,
      // removes partial B material, revision B never commits.
      await this.retainRevisionMaterial(projectId, revisionId, paths.workingCopy);
      await this.validateRetainedMaterial(projectId, revision, paths.workingCopy);
      const project = ProjectSchema.parse({
        ...current.project,
        sourcePath: source,
        updatedAt: timestamp,
      });
      const managedCopy = ManagedProjectCopySchema.parse({
        ...current.managedCopy,
        currentRevisionId: revisionId,
        state: 'ready',
        runtimeInstanceId: undefined,
        updatedAt: timestamp,
      });
      const completedContext = prepared;
      this.repository.transaction(() => {
        this.repository.saveProject(project);
        this.repository.saveRevision(revision);
        this.contexts.persist(completedContext);
        this.repository.saveManagedCopy(managedCopy);
        operation = RuntimeOperationSchema.parse({
          ...operation,
          stage: 'committed',
          updatedAt: nowIsoTimestamp(),
        });
        this.repository.saveRuntimeOperation(operation);
      });
      databaseCommitted = true;
      await this.fault('after_database_committed');
      try {
        await rm(backup, { recursive: true, force: true });
        this.repository.deleteRuntimeOperation(operation.id);
      } catch {
        // The committed operation remains as a durable cleanup marker.
      }
      return { project, managedCopy, revision, context: completedContext.context };
    } catch (cause) {
      if (databaseCommitted) throw cause;
      try {
        if (await exists(backup)) {
          await rm(paths.workingCopy, { recursive: true, force: true });
          await rename(backup, paths.workingCopy);
        }
        await rm(staging, { recursive: true, force: true });
        // Partial B material never becomes current: remove it so no
        // orphan immutable bytes reference an uncommitted revision.
        await rm(revisionMaterialPath(this.dataRoot, projectId, revisionId), {
          recursive: true,
          force: true,
        });
        if (prepared !== undefined) await this.contexts.discard(prepared);
        this.repository.transaction(() => {
          this.repository.saveManagedCopy(
            ManagedProjectCopySchema.parse({
              ...current.managedCopy,
              state: 'ready',
              runtimeInstanceId: undefined,
              updatedAt: nowIsoTimestamp(),
            }),
          );
          this.repository.deleteRuntimeOperation(operation.id);
        });
      } catch (recoveryCause) {
        throw new ProjectManagerError(
          'PROJECT_UPDATE_FAILED',
          'Project update failed and requires startup recovery',
          { cause: recoveryCause },
        );
      }
      if (cause instanceof ProjectManagerError) throw cause;
      throw new ProjectManagerError(
        'PROJECT_UPDATE_FAILED',
        'Project update failed; previous working copy was preserved',
        { cause },
      );
    }
  }

  lockProjectForRun(projectId: ProjectId, runId: QARunId): ManagedProjectCopy {
    const lease = this.runtimeLease();
    return this.repository.transaction(() => {
      const current = this.getManagedCopy(projectId);
      if (current.state !== 'ready') {
        throw new ProjectManagerError(
          current.state === 'locked_for_run' ? 'ACTIVE_RUN_EXISTS' : 'PROJECT_LOCKED',
          current.state === 'locked_for_run'
            ? 'Project already has active run ' + current.lockedByQARunId
            : 'Project is not ready for a run: ' + current.state,
        );
      }
      const locked = ManagedProjectCopySchema.parse({
        ...current,
        state: 'locked_for_run',
        lockedByQARunId: runId,
        runtimeInstanceId: lease.instanceId,
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveManagedCopy(locked);
      return locked;
    });
  }

  unlockProjectAfterRun(projectId: ProjectId, runId: QARunId): ManagedProjectCopy {
    const lease = this.runtimeLease();
    return this.repository.transaction(() => {
      const current = this.getManagedCopy(projectId);
      if (
        current.state !== 'locked_for_run' ||
        current.lockedByQARunId !== runId ||
        current.runtimeInstanceId !== lease.instanceId
      ) {
        throw new ProjectManagerError(
          'PROJECT_LOCKED',
          'Runtime and run do not own the managed project lock',
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
    // v2 revisions were hashed with the default exclusion set: the rescan
    // must apply the same set or every check reports phantom drift.
    const exclude = current.revision.hashVersion === 2 ? exclusionPredicate(undefined) : undefined;
    const actual = await this.snapshots.scanRevision(
      projectDataPaths(this.dataRoot, projectId).workingCopy,
      undefined,
      { ...(exclude === undefined ? {} : { exclude }) },
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
    const lease = this.runtimeLease();
    const paths = projectDataPaths(this.dataRoot, projectId);
    const tombstone = paths.root + '.deleting';
    const timestamp = nowIsoTimestamp();
    let operation = RuntimeOperationSchema.parse({
      schemaVersion: 1,
      id: createOperationId(),
      projectId,
      runtimeInstanceId: lease.instanceId,
      type: 'project_delete',
      stage: 'deleting',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.repository.transaction(() => {
      const copy = this.getManagedCopy(projectId);
      if (copy.state !== 'ready') {
        throw new ProjectManagerError('PROJECT_LOCKED', 'Project cannot be deleted while active');
      }
      this.repository.saveRuntimeOperation(operation);
      this.repository.saveManagedCopy(
        ManagedProjectCopySchema.parse({
          ...copy,
          state: 'deleting',
          runtimeInstanceId: lease.instanceId,
          updatedAt: timestamp,
        }),
      );
    });
    try {
      await this.fault('after_delete_marked');
      lease.assertHealthy();
      await rm(tombstone, { recursive: true, force: true });
      await rename(paths.root, tombstone);
      operation = RuntimeOperationSchema.parse({
        ...operation,
        stage: 'tombstoned',
        updatedAt: nowIsoTimestamp(),
      });
      this.repository.saveRuntimeOperation(operation);
      await this.fault('after_delete_tombstoned');
      lease.assertHealthy();
      this.repository.transaction(() => {
        this.repository.deleteProject(projectId);
        operation = RuntimeOperationSchema.parse({
          ...operation,
          stage: 'database_deleted',
          updatedAt: nowIsoTimestamp(),
        });
        this.repository.saveRuntimeOperation(operation);
      });
      await this.fault('after_delete_committed');
      try {
        await rm(tombstone, { recursive: true, force: true });
        this.repository.deleteRuntimeOperation(operation.id);
      } catch {
        // The database-deleted operation is retained so startup can finish cleanup.
      }
    } catch (cause) {
      const projectStillExists = this.repository.getProject(projectId) !== undefined;
      if (projectStillExists) {
        try {
          if ((await exists(tombstone)) && !(await exists(paths.root))) {
            await rename(tombstone, paths.root);
          }
          const copy = this.getManagedCopy(projectId);
          this.repository.transaction(() => {
            this.repository.saveManagedCopy(
              ManagedProjectCopySchema.parse({
                ...copy,
                state: 'ready',
                runtimeInstanceId: undefined,
                updatedAt: nowIsoTimestamp(),
              }),
            );
            this.repository.deleteRuntimeOperation(operation.id);
          });
        } catch {
          // Preserve the durable deletion operation for startup recovery.
        }
      }
      throw new ProjectManagerError('PROJECT_DELETE_FAILED', 'Project deletion failed', { cause });
    }
  }

  async recoverAbandonedOperations(observer: RuntimeInstanceLease): Promise<void> {
    for (const operation of this.repository.listRuntimeOperations()) {
      if (observer.isFresh(operation.runtimeInstanceId)) continue;
      if (operation.type === 'project_update') await this.recoverUpdate(operation);
      else await this.recoverDelete(operation);
    }
  }

  recoverAbandonedRunLock(projectId: ProjectId, runId: QARunId): void {
    const copy = this.getManagedCopy(projectId);
    if (copy.state !== 'locked_for_run' || copy.lockedByQARunId !== runId) return;
    this.repository.saveManagedCopy(
      ManagedProjectCopySchema.parse({
        schemaVersion: 1,
        projectId,
        currentRevisionId: copy.currentRevisionId,
        state: 'ready',
        updatedAt: nowIsoTimestamp(),
      }),
    );
  }

  private async recoverUpdate(operation: RuntimeOperation): Promise<void> {
    const paths = projectDataPaths(this.dataRoot, operation.projectId);
    const backup = resolve(paths.root, 'working-copy.backup');
    const copy = this.repository.getManagedCopy(operation.projectId);
    if (operation.stage === 'committed' || copy?.state === 'ready') {
      await rm(backup, { recursive: true, force: true });
      await rm(paths.staging, { recursive: true, force: true });
      await mkdir(paths.staging, { recursive: true });
      this.repository.deleteRuntimeOperation(operation.id);
      return;
    }
    if (copy === undefined) {
      this.repository.deleteRuntimeOperation(operation.id);
      return;
    }
    if (await exists(backup)) {
      await rm(paths.workingCopy, { recursive: true, force: true });
      await rename(backup, paths.workingCopy);
    } else {
      await stat(paths.workingCopy);
    }
    await rm(paths.staging, { recursive: true, force: true });
    await mkdir(paths.staging, { recursive: true });
    if (operation.stagedArtifactPath !== undefined) {
      await rm(resolveInside(this.dataRoot, operation.stagedArtifactPath), { force: true });
    }
    this.repository.transaction(() => {
      this.repository.saveManagedCopy(
        ManagedProjectCopySchema.parse({
          schemaVersion: 1,
          projectId: copy.projectId,
          currentRevisionId: copy.currentRevisionId,
          state: 'ready',
          updatedAt: nowIsoTimestamp(),
        }),
      );
      this.repository.deleteRuntimeOperation(operation.id);
    });
  }

  private async recoverDelete(operation: RuntimeOperation): Promise<void> {
    const paths = projectDataPaths(this.dataRoot, operation.projectId);
    const tombstone = paths.root + '.deleting';
    const project = this.repository.getProject(operation.projectId);
    if (project === undefined || operation.stage === 'database_deleted') {
      await rm(tombstone, { recursive: true, force: true });
      await rm(paths.root, { recursive: true, force: true });
      this.repository.deleteRuntimeOperation(operation.id);
      return;
    }
    if ((await exists(tombstone)) && !(await exists(paths.root))) {
      await rename(tombstone, paths.root);
    }
    const copy = this.getManagedCopy(operation.projectId);
    this.repository.transaction(() => {
      this.repository.saveManagedCopy(
        ManagedProjectCopySchema.parse({
          ...copy,
          state: 'ready',
          runtimeInstanceId: undefined,
          updatedAt: nowIsoTimestamp(),
        }),
      );
      this.repository.deleteRuntimeOperation(operation.id);
    });
  }

  private async preflightStorage(
    source: string,
    destination: string,
    signal?: AbortSignal,
    exclude?: (relativePath: string) => boolean,
  ): Promise<void> {
    const estimate = await estimateTree(source, signal, {
      ...(exclude === undefined ? {} : { exclude }),
    });
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
