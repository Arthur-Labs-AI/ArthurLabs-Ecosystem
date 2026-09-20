import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  createSnapshotId,
  nowIsoTimestamp,
  type ProjectId,
  type ProjectRevisionId,
  type QARunId,
  type SnapshotId,
} from '@qa/shared';
import { ProjectSnapshotSchema, type ProjectSnapshot, type SnapshotSourceState } from '@qa/schemas';
import {
  FilesystemArtifactStore,
  type SentryRepository,
  resolveInside,
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

  scanRevision(
    root: string,
    signal?: AbortSignal,
    options: { readonly exclude?: (relativePath: string) => boolean } = {},
  ): Promise<ScanTreeResult> {
    return scanTree(root, {
      ...(signal === undefined ? {} : { signal }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    });
  }

  /**
   * Authoritative baseline file hashes for one frozen snapshot, streamed
   * from the stored NDJSON manifest (file entries only). No rescan: the
   * manifest was written at snapshot-creation time from the locked revision.
   */
  async baselineFileHashes(snapshotId: SnapshotId): Promise<ReadonlyMap<string, string>> {
    const snapshot = this.repository.getSnapshot(snapshotId);
    if (snapshot === undefined) throw new Error('SNAPSHOT_NOT_FOUND: ' + snapshotId);
    const artifact = this.repository.getArtifact(snapshot.manifest.artifactId);
    if (artifact === undefined) throw new Error('SNAPSHOT_MANIFEST_MISSING: ' + snapshotId);
    const absolute = resolveInside(this.dataRoot, artifact.relativeStoragePath);
    const hashes = new Map<string, string>();
    const lines = createInterface({ input: createReadStream(absolute), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let entry: { relativePath?: unknown; type?: unknown; sha256?: unknown };
      try {
        entry = JSON.parse(line) as { relativePath?: unknown; type?: unknown; sha256?: unknown };
      } catch {
        continue;
      }
      if (
        entry.type === 'file' &&
        typeof entry.relativePath === 'string' &&
        typeof entry.sha256 === 'string' &&
        /^[0-9a-fA-F]{64}$/.test(entry.sha256)
      ) {
        hashes.set(entry.relativePath, 'sha256:' + entry.sha256.toLowerCase());
      }
    }
    return hashes;
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
