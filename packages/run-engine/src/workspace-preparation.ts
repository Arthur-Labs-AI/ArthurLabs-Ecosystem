import { readFile, readdir, realpath, lstat, unlink, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isPathInside } from '@qa/persistence';
import { createHash } from 'node:crypto';
import {
  SystemdSandboxBackend,
  resolveExecutable,
  type VerificationSandboxBackend,
} from '@qa/verifier';

export interface PreparationPolicy {
  readonly enabled: boolean;
  /** Operator-provisioned pnpm store. Read-only; never populated by agent code. */
  readonly cacheSeed?: string;
  readonly path: string;
}
export interface PreparationReceipt {
  readonly status: 'ready' | 'limited';
  readonly reason: string;
  readonly removedBuildCaches: number;
  readonly lockfileHash?: string;
  readonly packageManager?: string;
  /** A failed install may have partially materialized dependencies. */
  readonly needsFreshCopy?: true;
}
export interface PreparationInput {
  readonly workspaceRoot: string;
  readonly policy: PreparationPolicy;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}
export type WorkspacePreparer = (input: PreparationInput) => Promise<PreparationReceipt>;

/** Walk only physical directories; imported symlinks must never widen cleanup. */
export async function removeBuildCaches(root: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    signal?.throwIfAborted();
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && !['node_modules', '.git', 'dist'].includes(entry.name))
      removed += await removeBuildCaches(path, signal);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tsbuildinfo')) {
      await unlink(path);
      removed += 1;
    }
  }
  return removed;
}

/** No shell interpolation, project hooks, network, or unrestricted host fallback. */
export function createWorkspacePreparer(
  backend: VerificationSandboxBackend = new SystemdSandboxBackend(),
): WorkspacePreparer {
  return async ({ workspaceRoot, policy, deadlineAt, signal }) => {
    signal.throwIfAborted();
    const removedBuildCaches = await removeBuildCaches(workspaceRoot, signal);
    const limited = (reason: string): PreparationReceipt => ({
      status: 'limited',
      reason,
      removedBuildCaches,
    });
    let manifest: { packageManager?: unknown };
    try {
      manifest = JSON.parse(
        await readFile(join(workspaceRoot, 'package.json'), 'utf8'),
      ) as typeof manifest;
    } catch {
      return limited('No readable Node package manifest; source review only.');
    }
    const version =
      manifest !== null &&
      typeof manifest === 'object' &&
      typeof manifest.packageManager === 'string'
        ? /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1]
        : undefined;
    if (version === undefined)
      return limited('Preparation supports an explicitly pinned pnpm version only.');
    let lock: Buffer;
    try {
      lock = await readFile(join(workspaceRoot, 'pnpm-lock.yaml'));
    } catch {
      return limited('Missing pnpm lockfile; dependency installation was not attempted.');
    }
    if (policy.cacheSeed === undefined || policy.cacheSeed.trim().length === 0)
      return limited(
        'No offline dependency cache configured; executable checks may be unavailable.',
      );
    const root = await realpath(workspaceRoot);
    const seed = await realpath(policy.cacheSeed);
    // Cache must be independent of all agent-controlled project files.
    if (isPathInside(root, seed) || isPathInside(seed, root))
      throw new Error('QA_PREPARATION_CACHE_OVERLAP');
    if (!(await lstat(seed)).isDirectory()) throw new Error('QA_PREPARATION_INVALID_CACHE');
    const executable = await resolveExecutable('pnpm', policy.path);
    if (executable === undefined) return limited('Pinned package manager is not installed.');
    const pnpmExecutable = await realpath(executable);
    let pnpmRoot = dirname(pnpmExecutable);
    let trustedPackage = false;
    for (let level = 0; level < 3; level += 1) {
      try {
        const owner = JSON.parse(await readFile(join(pnpmRoot, 'package.json'), 'utf8')) as {
          name?: unknown;
        };
        if (owner?.name === 'pnpm') {
          trustedPackage = true;
          break;
        }
      } catch {
        /* Continue only through a bounded installed tool path. */
      }
      pnpmRoot = dirname(pnpmRoot);
    }
    if (!trustedPackage)
      return limited(
        'A directly installed pnpm package is required; automatic toolchain downloads are disabled.',
      );
    const available = await backend.preflight(dirname(root));
    if (!available.available) throw new Error('QA_PREPARATION_SANDBOX_UNAVAILABLE');
    const privateRoot = resolve(root, '..', '.sentry-preparation');
    await mkdir(privateRoot, { recursive: true });
    const environment = await backend.createEnvironment({
      workspaceRoot: root,
      attemptRoot: privateRoot,
      runtimeBinds: [dirname(process.execPath), pnpmRoot, seed],
      inaccessiblePaths: [],
    });
    const env = {
      PATH: [dirname(process.execPath), dirname(pnpmExecutable), '/usr/bin', '/bin'].join(':'),
      COREPACK_ENABLE_NETWORK: '0',
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      CI: 'true',
    };
    const run = async (command: string, args: readonly string[], cwd = root) => {
      signal.throwIfAborted();
      const timeoutMs = Math.min(120_000, deadlineAt - Date.now());
      if (timeoutMs <= 0) throw new Error('QA_PREPARATION_TIMEOUT');
      const result = await environment.run({
        executable: command,
        args,
        cwd,
        env,
        timeoutMs,
        signal,
      });
      if (result.failure === 'process_tree_cleanup_failed')
        throw new Error('QA_PREPARATION_PROCESS_CLEANUP_FAILED');
      signal.throwIfAborted();
      if (result.timedOut || result.failure !== undefined)
        throw new Error('QA_PREPARATION_EXECUTION_FAILED');
      return result;
    };
    const dispose = async (): Promise<void> => {
      if ((await environment.dispose()) !== 'clean')
        throw new Error('QA_PREPARATION_CLEANUP_FAILED');
    };
    try {
      // Even `pnpm --version` can discover project hooks when run in the project.
      const installed = await run(pnpmExecutable, ['--version'], join(privateRoot, 'home'));
      if (installed.exitCode !== 0 || installed.stdout.trim() !== version)
        return limited('Installed pnpm version differs from the project pin.');
      // Every worker receives a private store and copied package files. No shared writes.
      const store = join(privateRoot, 'home', 'pnpm-store');
      const copied = await run('/usr/bin/cp', ['-a', '--reflink=auto', '--', seed, store]);
      if (copied.exitCode !== 0) throw new Error('QA_PREPARATION_CACHE_COPY_FAILED');
      const installedPackages = await run(pnpmExecutable, [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--package-import-method=copy',
        '--store-dir',
        store,
      ]);
      if (installedPackages.exitCode !== 0)
        return {
          ...limited(
            'Offline dependency installation could not complete; clean source review only.',
          ),
          needsFreshCopy: true,
        };
      return {
        status: 'ready',
        reason: 'Offline dependencies prepared; lifecycle scripts disabled.',
        removedBuildCaches,
        packageManager: 'pnpm@' + version,
        lockfileHash: createHash('sha256').update(lock).digest('hex'),
      };
    } finally {
      await dispose();
    }
  };
}
