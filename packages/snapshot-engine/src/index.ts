import { createHash } from 'node:crypto';
import {
  createSnapshotId,
  nowIsoTimestamp,
  type ProjectId,
  type ProjectRevisionId,
  type QARunId,
} from '@qa/shared';
import { ProjectSnapshotSchema, type ProjectSnapshot, type SnapshotSourceState } from '@qa/schemas';
import {
  FilesystemArtifactStore,
  type SentryRepository,
  runDataPaths,
  scanTree,
  snapshotEntry,
  walkTree,
  type ScanTreeResult,
} from '@qa/persistence';

export interface CreateSnapshotInput {
  readonly projectId: ProjectId;
  readonly projectRevisionId: ProjectRevisionId;
  readonly qaRunId: QARunId;
  readonly workingCopyPath: string;
  readonly sourceState?: SnapshotSourceState;
  readonly signal?: AbortSignal;
}

export class SnapshotEngine {
  private readonly artifacts: FilesystemArtifactStore;

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
  ) {
    this.artifacts = new FilesystemArtifactStore(dataRoot, repository);
  }

  scanRevision(root: string, signal?: AbortSignal): Promise<ScanTreeResult> {
    return scanTree(root, { ...(signal === undefined ? {} : { signal }) });
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<ProjectSnapshot> {
    const aggregate = createHash('sha256');
    let entryCount = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let symlinkCount = 0;
    let totalBytes = 0;
    const source = (async function* (): AsyncGenerator<string> {
      for await (const walked of walkTree(input.workingCopyPath, input.signal)) {
        const entry = await snapshotEntry(walked, input.signal);
        const line = JSON.stringify(entry) + '\n';
        aggregate.update(line, 'utf8');
        entryCount += 1;
        if (entry.type === 'file') {
          fileCount += 1;
          totalBytes += entry.sizeBytes;
        } else if (entry.type === 'directory') directoryCount += 1;
        else symlinkCount += 1;
        yield line;
      }
    })();
    const manifestPath =
      runDataPaths(this.dataRoot, input.projectId, input.qaRunId).snapshot + '/manifest.ndjson';
    const relativePath = manifestPath
      .slice(this.dataRoot.length)
      .replace(/^[\\/]+/, '')
      .replaceAll('\\', '/');
    const artifact = await this.artifacts.write({
      relativePath,
      type: 'json',
      source,
      projectId: input.projectId,
      qaRunId: input.qaRunId,
      mimeType: 'application/x-ndjson',
    });
    const snapshot = ProjectSnapshotSchema.parse({
      schemaVersion: 1,
      id: createSnapshotId(),
      projectId: input.projectId,
      projectRevisionId: input.projectRevisionId,
      createdAt: nowIsoTimestamp(),
      sourceState: input.sourceState ?? {},
      manifest: {
        entryCount,
        fileCount,
        directoryCount,
        symlinkCount,
        totalBytes,
        artifactId: artifact.id,
      },
      contentHash: aggregate.digest('hex'),
    });
    this.repository.saveSnapshot(snapshot);
    return snapshot;
  }
}

export { scanTree, snapshotEntry, walkTree } from '@qa/persistence';
