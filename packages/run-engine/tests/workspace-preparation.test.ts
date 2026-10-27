import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspacePreparer } from '../src/workspace-preparation.js';
import type { SandboxCommandInput, VerificationSandboxBackend } from '@qa/verifier';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-preparation-'));
  roots.push(root);
  const workspaceRoot = join(root, 'project');
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@9.12.3' }),
  );
  await writeFile(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  return {
    root,
    workspaceRoot,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 120_000,
  };
}

async function binaryFixture(root: string) {
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'package.json'), JSON.stringify({ name: 'pnpm' }));
  for (const name of ['pnpm', 'pnpm.exe', 'pnpm.cmd']) {
    await writeFile(join(bin, name), 'fixture binary');
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}
describe('private workspace preparation', () => {
  it('cleans incremental state only in its own copy and records a missing cache honestly', async () => {
    const a = await fixture();
    const b = await fixture();
    await writeFile(join(a.workspaceRoot, 'tsconfig.tsbuildinfo'), 'stale');
    await writeFile(join(b.workspaceRoot, 'tsconfig.tsbuildinfo'), 'peer');
    const receipt = await createWorkspacePreparer()({ ...a, policy: { enabled: true, path: '' } });
    expect(receipt.status).toBe('limited');
    expect(receipt.removedBuildCaches).toBe(1);
    expect(await readFile(join(b.workspaceRoot, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('peer');
  });
  it('does not install an unpinned package manager or choose versions itself', async () => {
    const a = await fixture();
    await writeFile(join(a.workspaceRoot, 'package.json'), '{}');
    const receipt = await createWorkspacePreparer()({ ...a, policy: { enabled: true, path: '' } });
    expect(receipt.reason).toContain('explicitly pinned');
  });
  it('stops before I/O when cancelled', async () => {
    const a = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWorkspacePreparer()({
        ...a,
        signal: controller.signal,
        policy: { enabled: true, path: '' },
      }),
    ).rejects.toThrow();
  });
  it.each(['cache', '..cache'])(
    'refuses a project-controlled cache seed %s before executing commands',
    async (name) => {
      const a = await fixture();
      const seed = join(a.workspaceRoot, name);
      await mkdir(seed);
      await expect(
        createWorkspacePreparer()({ ...a, policy: { enabled: true, path: '', cacheSeed: seed } }),
      ).rejects.toThrow('CACHE_OVERLAP');
    },
  );
  it('never falls back to host execution when isolation is unavailable', async () => {
    const a = await fixture();
    const seed = join(a.root, 'cache');
    await mkdir(seed);
    const backend: VerificationSandboxBackend = {
      id: 'none',
      preflight: async () => ({ available: false, backend: 'none' }),
      createEnvironment: async () => {
        throw new Error('unexpected execution');
      },
    };
    await expect(
      createWorkspacePreparer(backend)({
        ...a,
        policy: { enabled: true, path: await binaryFixture(a.root), cacheSeed: seed },
      }),
    ).rejects.toThrow('QA_PREPARATION_SANDBOX_UNAVAILABLE');
  });

  it('uses a private store for each copy, frozen offline installs, and no inherited credentials', async () => {
    const a = await fixture();
    const b = await fixture();
    const seed = join(a.root, 'seed');
    await mkdir(seed);
    const path = await binaryFixture(a.root);
    const commands: SandboxCommandInput[] = [];
    let disposed = 0;
    const backend: VerificationSandboxBackend = {
      id: 'systemd',
      preflight: async () => ({ available: true, backend: 'systemd' }),
      createEnvironment: async (input) => {
        expect(input.runtimeBinds).toContain(seed);
        return {
          sandboxId: 'fixture',
          run: async (command) => {
            commands.push(command);
            return {
              exitCode: 0,
              stdout: command.args.includes('--version') ? '9.12.3\n' : '',
              stderr: '',
              timedOut: false,
              durationMs: 1,
            };
          },
          dispose: async () => {
            disposed += 1;
            return 'clean';
          },
        };
      },
    };
    const prepare = createWorkspacePreparer(backend);
    const policy = { enabled: true, path, cacheSeed: seed };
    expect((await prepare({ ...a, policy })).status).toBe('ready');
    expect((await prepare({ ...b, policy })).status).toBe('ready');
    const installs = commands.filter((command) => command.args[0] === 'install');
    expect(
      commands
        .filter((command) => command.args.includes('--version'))
        .map((command) => command.cwd),
    ).toEqual([
      join(a.root, '.sentry-preparation', 'home'),
      join(b.root, '.sentry-preparation', 'home'),
    ]);
    expect(installs).toHaveLength(2);
    for (const command of installs) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          '--offline',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--package-import-method=copy',
        ]),
      );
      expect(Object.keys(command.env).sort()).toEqual([
        'CI',
        'COREPACK_ENABLE_NETWORK',
        'COREPACK_ENABLE_PROJECT_SPEC',
        'PATH',
      ]);
    }
    expect(installs[0]!.args.at(-1)).not.toBe(installs[1]!.args.at(-1));
    expect(disposed).toBe(2);
  });
});
