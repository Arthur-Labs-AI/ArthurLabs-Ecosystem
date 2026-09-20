import { createReadStream, createWriteStream, constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  opendir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { SnapshotFileEntrySchema, type SnapshotFileEntry } from '@qa/schemas';
import { isPathInside } from './paths.js';

export interface CopyProgress {
  readonly filesProcessed: number;
  readonly bytesProcessed: number;
  readonly currentRelativePath: string;
}

export interface CopyTreeOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly exclude?: (relativePath: string) => boolean;
  readonly preferReflink?: boolean;
  readonly onProgress?: (progress: CopyProgress) => void;
  readonly symlinkPolicy?: 'preserve' | 'inert-unsafe';
  readonly blockedLinkMetadataRoot?: string;
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
  readonly linkTarget?: string;
  readonly linkScope?: 'internal' | 'external' | 'broken';
  readonly linkTargetRelativePath?: string;
  readonly linkTargetType?: 'file' | 'directory';
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

export interface WalkTreeOptions {
  readonly signal?: AbortSignal;
  /** Skip entries whose relative path matches; excluded directories are pruned (never descended). */
  readonly exclude?: (relativePath: string) => boolean;
}

/** Deterministic lstat traversal. Symlinks are yielded and never followed. */
export async function* walkTree(
  root: string,
  signalOrOptions?: AbortSignal | WalkTreeOptions,
): AsyncGenerator<WalkEntry> {
  const options: WalkTreeOptions =
    signalOrOptions === undefined || signalOrOptions instanceof AbortSignal
      ? { ...(signalOrOptions === undefined ? {} : { signal: signalOrOptions }) }
      : signalOrOptions;
  const signal = options.signal;
  const exclude = options.exclude;
  const absoluteRoot = resolve(root);
  const canonicalRoot = await realpath(absoluteRoot);

  const classifyLink = async (
    absolutePath: string,
  ): Promise<
    Pick<WalkEntry, 'linkTarget' | 'linkScope' | 'linkTargetRelativePath' | 'linkTargetType'>
  > => {
    const linkTarget = await readlink(absolutePath);
    const unresolvedTarget = isAbsolute(linkTarget)
      ? resolve(linkTarget)
      : resolve(dirname(absolutePath), linkTarget);
    try {
      const canonicalTarget = await realpath(unresolvedTarget);
      const targetStat = await stat(canonicalTarget);
      const internal = isPathInside(
        process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot,
        process.platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget,
      );
      return {
        linkTarget: linkTarget.replaceAll('\\', '/'),
        linkScope: internal ? 'internal' : 'external',
        ...(internal
          ? {
              linkTargetRelativePath: relative(canonicalRoot, canonicalTarget).replaceAll(
                '\\',
                '/',
              ),
            }
          : {}),
        ...(targetStat.isDirectory()
          ? { linkTargetType: 'directory' as const }
          : targetStat.isFile()
            ? { linkTargetType: 'file' as const }
            : {}),
      };
    } catch {
      return { linkTarget: linkTarget.replaceAll('\\', '/'), linkScope: 'broken' };
    }
  };

  async function* visit(directory: string): AsyncGenerator<WalkEntry> {
    throwIfAborted(signal);
    for (const name of await sortedNames(directory)) {
      throwIfAborted(signal);
      const absolutePath = join(directory, name);
      const stats = await lstat(absolutePath);
      const relativePath = relative(absoluteRoot, absolutePath).replaceAll('\\', '/');
      if (exclude?.(relativePath) === true) continue;
      if (stats.isSymbolicLink()) {
        yield {
          absolutePath,
          relativePath,
          type: 'symlink',
          sizeBytes: 0,
          mode: stats.mode,
          ...(await classifyLink(absolutePath)),
        };
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
    const target = entry.linkTarget ?? (await readlink(entry.absolutePath)).replaceAll('\\', '/');
    sha256 = createHash('sha256')
      .update((entry.linkScope ?? 'broken') + '\0' + target, 'utf8')
      .digest('hex');
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
    ...(entry.type === 'symlink'
      ? { linkTarget: entry.linkTarget, linkScope: entry.linkScope }
      : {}),
  });
}

function destinationForRelative(root: string, relativePath: string): string {
  return resolve(root, ...relativePath.split('/'));
}

async function copySymlink(
  entry: WalkEntry,
  destinationRoot: string,
  destination: string,
  policy: 'preserve' | 'inert-unsafe',
  blockedLinkMetadataRoot?: string,
): Promise<void> {
  const scope = entry.linkScope ?? 'broken';
  const target = entry.linkTarget ?? (await readlink(entry.absolutePath)).replaceAll('\\', '/');
  await mkdir(dirname(destination), { recursive: true });
  if (scope !== 'internal' && policy === 'inert-unsafe') {
    if (blockedLinkMetadataRoot === undefined) {
      throw new Error('BLOCKED_LINK_METADATA_ROOT_REQUIRED');
    }
    const metadataName = createHash('sha256').update(entry.relativePath, 'utf8').digest('hex');
    const metadataPath = resolve(blockedLinkMetadataRoot, metadataName + '.json');
    if (!isPathInside(resolve(blockedLinkMetadataRoot), metadataPath)) {
      throw new Error('BLOCKED_LINK_METADATA_PATH_ESCAPE');
    }
    await mkdir(blockedLinkMetadataRoot, { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        relativePath: entry.relativePath,
        linkTarget: target,
        linkScope: scope,
        reason:
          scope === 'external'
            ? 'Link resolves outside the copied project root and is inert in agent workspaces.'
            : 'Link target cannot be resolved and is inert in agent workspaces.',
      }) + '\n',
      { flag: 'wx' },
    );
    return;
  }

  let copiedTarget = target;
  if (scope === 'internal' && entry.linkTargetRelativePath !== undefined) {
    const localTarget = destinationForRelative(destinationRoot, entry.linkTargetRelativePath);
    copiedTarget =
      process.platform === 'win32' && entry.linkTargetType === 'directory'
        ? localTarget
        : relative(dirname(destination), localTarget) || '.';
  }
  const type =
    process.platform === 'win32' && entry.linkTargetType === 'directory'
      ? 'junction'
      : entry.linkTargetType === 'directory'
        ? 'dir'
        : entry.linkTargetType === 'file'
          ? 'file'
          : undefined;
  await symlink(copiedTarget, destination, type);
}

export interface ScanTreeResult extends TreeStats {
  readonly entryCount: number;
  readonly contentHash: string;
}

export async function estimateTree(
  root: string,
  signal?: AbortSignal,
  options: { readonly exclude?: (relativePath: string) => boolean } = {},
): Promise<TreeStats> {
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;
  for await (const entry of walkTree(root, {
    ...(signal === undefined ? {} : { signal }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  })) {
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
    readonly exclude?: (relativePath: string) => boolean;
  } = {},
): Promise<ScanTreeResult> {
  const aggregate = createHash('sha256');
  let entryCount = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;
  for await (const walked of walkTree(root, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  })) {
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
    for await (const entry of walkTree(sourceRoot, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    })) {
      throwIfAborted(options.signal);
      const destination = destinationForRelative(destinationRoot, entry.relativePath);
      if (entry.type === 'directory') {
        await mkdir(destination, { recursive: true });
        directoryCount += 1;
        continue;
      }
      if (entry.type === 'symlink') {
        await copySymlink(
          entry,
          destinationRoot,
          destination,
          options.symlinkPolicy ?? 'preserve',
          options.blockedLinkMetadataRoot,
        );
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
