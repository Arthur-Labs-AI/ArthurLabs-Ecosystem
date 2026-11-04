import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative } from 'node:path';
import { once } from 'node:events';
import { createArtifactId, nowIsoTimestamp, type ProjectId, type QARunId } from '@qa/shared';
import { ArtifactSchema, type Artifact, type ArtifactType } from '@qa/schemas';
import type { SentryRepository } from './repository.js';
import { resolveInside } from './paths.js';
import { RuntimePersistenceError } from './errors.js';

export interface WriteArtifactInput {
  readonly relativePath: string;
  readonly type: ArtifactType;
  readonly source: AsyncIterable<Uint8Array | string>;
  readonly projectId?: ProjectId;
  readonly qaRunId?: QARunId;
  readonly mimeType?: string;
  readonly persistMetadata?: boolean;
}

export class FilesystemArtifactStore {
  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
  ) {}

  async write(input: WriteArtifactInput): Promise<Artifact> {
    const id = createArtifactId();
    const finalPath = resolveInside(this.dataRoot, input.relativePath);
    const temporaryPath = finalPath + '.' + id + '.tmp';
    await mkdir(dirname(finalPath), { recursive: true });
    const output = createWriteStream(temporaryPath, { flags: 'wx' });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let finalized = false;
    try {
      for await (const rawChunk of input.source) {
        const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
        sizeBytes += chunk.byteLength;
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      await rename(temporaryPath, finalPath);
      finalized = true;
      const relativeStoragePath = relative(this.dataRoot, finalPath).replaceAll('\\', '/');
      const artifact = ArtifactSchema.parse({
        schemaVersion: 1,
        id,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.qaRunId === undefined ? {} : { qaRunId: input.qaRunId }),
        type: input.type,
        relativeStoragePath,
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        sizeBytes,
        sha256: hash.digest('hex'),
        createdAt: nowIsoTimestamp(),
      });
      if (input.persistMetadata ?? true) this.repository.saveArtifact(artifact);
      return artifact;
    } catch (cause) {
      output.destroy();
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (finalized) await rm(finalPath, { force: true }).catch(() => undefined);
      throw new RuntimePersistenceError(
        'ARTIFACT_WRITE_FAILED',
        'Unable to stream artifact to ' + input.relativePath,
        { cause },
      );
    }
  }

  open(artifact: Artifact): ReadStream {
    const validated = ArtifactSchema.parse(artifact);
    return createReadStream(resolveInside(this.dataRoot, validated.relativeStoragePath));
  }

  persist(artifact: Artifact): void {
    this.repository.saveArtifact(ArtifactSchema.parse(artifact));
  }

  async discard(artifact: Artifact): Promise<void> {
    const validated = ArtifactSchema.parse(artifact);
    await rm(resolveInside(this.dataRoot, validated.relativeStoragePath), { force: true });
  }

  async delete(artifact: Artifact): Promise<void> {
    const validated = ArtifactSchema.parse(artifact);
    // Let SQLite reject deletion of a referenced artifact before touching its bytes.
    // If the file removal subsequently fails, the only residue is an unreferenced
    // file rather than live metadata pointing at missing data.
    this.repository.deleteArtifact(validated.id);
    await rm(resolveInside(this.dataRoot, validated.relativeStoragePath), { force: true });
  }
}
