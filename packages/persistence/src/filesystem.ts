import { createReadStream, createWriteStream, constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, opendir, readlink, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { SnapshotFileEntrySchema, type SnapshotFileEntry } from '@qa/schemas';

export interface CopyProgress {
  readonly filesProcessed: number;
  readonly bytesProcessed: number;
  readonly currentRelativePath: string;
}

export interface CopyTreeOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly preferReflink?: boolean;
  readonly onProgress?: (progress: CopyProgress) => void;
}

export interface TreeStats {
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly totalBytes: number;
}

interface WalkEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly sizeBytes: number;
  readonly mode: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true)
    throw new Error('COPY_CANCELLED: filesystem operation was cancelled');
}

async function sortedNames(directory: string): Promise<string[]> {
  const names: string[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) names.push(entry.name);
  names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return names;
}

/** Deterministic lstat traversal. Symlinks are yielded and never followed. */
export async function* walkTree(root: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  const absoluteRoot = resolve(root);
  async function* visit(directory: string): AsyncGenerator<WalkEntry> {
    throwIfAborted(signal);
    for (const name of await sortedNames(directory)) {
      throwIfAborted(signal);
      const absolutePath = join(directory, name);
      const stats = await lstat(absolutePath);
      const relativePath = relative(absoluteRoot, absolutePath).replaceAll('\\', '/');
      if (stats.isSymbolicLink()) {
        yield { absolutePath, relativePath, type: 'symlink', sizeBytes: 0, mode: stats.mode };
      } else if (stats.isDirectory()) {
        yield { absolutePath, relativePath, type: 'directory', sizeBytes: 0, mode: stats.mode };
        yield* visit(absolutePath);
      } else if (stats.isFile()) {
        yield {
          absolutePath,
          relativePath,
          type: 'file',
          sizeBytes: stats.size,
          mode: stats.mode,
        };
      } else {
        throw new Error('UNSUPPORTED_FILESYSTEM_ENTRY: ' + relativePath);
      }
    }
  }
  yield* visit(absoluteRoot);
}

export async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(filePath);
  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } finally {
    input.destroy();
  }
}

export async function snapshotEntry(
  entry: WalkEntry,
  signal?: AbortSignal,
): Promise<SnapshotFileEntry> {
  let sha256: string;
  if (entry.type === 'file') {
    sha256 = await hashFile(entry.absolutePath, signal);
  } else if (entry.type === 'symlink') {
    const target = (await readlink(entry.absolutePath)).replaceAll('\\', '/');
    sha256 = createHash('sha256').update(target, 'utf8').digest('hex');
  } else {
    sha256 = createHash('sha256')
      .update('directory\0' + entry.relativePath, 'utf8')
      .digest('hex');
  }
  return SnapshotFileEntrySchema.parse({
    relativePath: entry.relativePath,
    type: entry.type,
    sizeBytes: entry.sizeBytes,
    sha256,
  });
}

export interface ScanTreeResult extends TreeStats {
  readonly entryCount: number;
  readonly contentHash: string;
}

export async function estimateTree(root: string, signal?: AbortSignal): Promise<TreeStats> {
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;
  for await (const entry of walkTree(root, signal)) {
    if (entry.type === 'file') {
      fileCount += 1;
      totalBytes += entry.sizeBytes;
    } else if (entry.type === 'directory') directoryCount += 1;
    else symlinkCount += 1;
  }
  return { fileCount, directoryCount, symlinkCount, totalBytes };
}

export async function scanTree(
  root: string,
  options: {
    readonly signal?: AbortSignal;
    readonly onEntry?: (entry: SnapshotFileEntry, canonicalLine: string) => void | Promise<void>;
  } = {},
): Promise<ScanTreeResult> {
  const aggregate = createHash('sha256');
  let entryCount = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;
  for await (const walked of walkTree(root, options.signal)) {
    const entry = await snapshotEntry(walked, options.signal);
    const line = JSON.stringify(entry) + '\n';
    aggregate.update(line, 'utf8');
    entryCount += 1;
    if (entry.type === 'file') {
      fileCount += 1;
      totalBytes += entry.sizeBytes;
    } else if (entry.type === 'directory') directoryCount += 1;
    else symlinkCount += 1;
    await options.onEntry?.(entry, line);
  }
  return {
    entryCount,
    fileCount,
    directoryCount,
    symlinkCount,
    totalBytes,
    contentHash: aggregate.digest('hex'),
  };
}

async function copyRegularFile(
  source: string,
  destination: string,
  mode: number,
  preferReflink: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (preferReflink) {
    try {
      await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE);
      await chmod(destination, mode);
      return;
    } catch {
      await rm(destination, { force: true });
    }
  }
  await pipeline(createReadStream(source), createWriteStream(destination, { mode }), { signal });
  await chmod(destination, mode);
}

export async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  options: CopyTreeOptions = {},
): Promise<TreeStats> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 64));
  const pending = new Set<Promise<void>>();
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;
  await mkdir(destinationRoot, { recursive: true });

  const schedule = async (operation: () => Promise<void>): Promise<void> => {
    while (pending.size >= concurrency) await Promise.race(pending);
    const task = operation();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };

  try {
    for await (const entry of walkTree(sourceRoot, options.signal)) {
      throwIfAborted(options.signal);
      const destination = resolve(destinationRoot, ...entry.relativePath.split('/'));
      if (entry.type === 'directory') {
        await mkdir(destination, { recursive: true });
        directoryCount += 1;
        continue;
      }
      if (entry.type === 'symlink') {
        const target = await readlink(entry.absolutePath);
        await mkdir(dirname(destination), { recursive: true });
        await symlink(target, destination);
        symlinkCount += 1;
        continue;
      }
      await schedule(async () => {
        await copyRegularFile(
          entry.absolutePath,
          destination,
          entry.mode,
          options.preferReflink ?? false,
          options.signal,
        );
        fileCount += 1;
        totalBytes += entry.sizeBytes;
        options.onProgress?.({
          filesProcessed: fileCount,
          bytesProcessed: totalBytes,
          currentRelativePath: entry.relativePath,
        });
      });
    }
    await Promise.all(pending);
  } catch (cause) {
    await Promise.allSettled(pending);
    throw cause;
  }
  return { fileCount, directoryCount, symlinkCount, totalBytes };
}
