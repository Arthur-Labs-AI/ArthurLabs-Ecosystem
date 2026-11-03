import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolchainDir } from '@qa/shared';
import { ToolchainManager, pickGoArchive, type GoRelease, type ScriptRunner } from '../src/toolchains.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const dataRoot = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), 'sentry-toolchains-'));
  roots.push(value);
  return value;
};

const okRunner = (seen: Array<{ script: string; env: Record<string, string> }>): ScriptRunner =>
  async (script, { cwd, env }) => {
    seen.push({ script, env: { ...env } });
    await writeFile(join(cwd, 'tool'), 'x');
    return { code: 0, output: '' };
  };

const releases: GoRelease[] = [
  { version: 'go1.24rc1', stable: false, files: [] },
  {
    version: 'go1.24.2',
    stable: true,
    files: [
      { filename: 'go1.24.2.linux-amd64.tar.gz', os: 'linux', arch: 'amd64', kind: 'archive', sha256: 'aaa' },
      { filename: 'go1.24.2.linux-arm64.tar.gz', os: 'linux', arch: 'arm64', kind: 'archive', sha256: 'bbb' },
    ],
  },
  {
    version: 'go1.23.8',
    stable: true,
    files: [{ filename: 'go1.23.8.linux-amd64.tar.gz', os: 'linux', arch: 'amd64', kind: 'archive', sha256: 'ccc' }],
  },
];

describe('toolchain manager', () => {
  it('picks the newest stable patch of a Go minor for this machine', () => {
    expect(pickGoArchive(releases, '1.24', 'x86_64')?.sha256).toBe('aaa');
    expect(pickGoArchive(releases, '1.24', 'aarch64')?.sha256).toBe('bbb');
    expect(pickGoArchive(releases, '1.23', 'x86_64')?.filename).toBe('go1.23.8.linux-amd64.tar.gz');
    expect(pickGoArchive(releases, '1.2', 'x86_64')).toBeUndefined();
  });

  it('installs a version into its own folder and reports it installed', async () => {
    const root = await dataRoot();
    const seen: Array<{ script: string; env: Record<string, string> }> = [];
    const manager = new ToolchainManager(root, okRunner(seen), async () => releases);
    expect(manager.install('dotnet', '8.0')).toEqual({ started: true });
    expect(manager.install('dotnet', '8.0')).toEqual({ started: false });
    await manager.settled();
    const dir = toolchainDir(root, 'dotnet', '8.0');
    expect(seen[0]?.env['SENTRY_TC_DIR']).toBe(dir);
    expect(seen[0]?.script).toContain('dotnet-install.sh');
    expect((await stat(join(dir, 'tool'))).isFile()).toBe(true);
    const pack = (await manager.status()).find((p) => p.id === 'dotnet');
    expect(pack?.versions.find((v) => v.version === '8.0')).toMatchObject({
      installed: true,
      installing: false,
    });
    expect(pack?.versions.find((v) => v.version === '9.0')?.installed).toBe(false);
  });

  it('removes a failed install completely and keeps the error visible', async () => {
    const root = await dataRoot();
    const failing: ScriptRunner = async () => ({ code: 22, output: 'curl: (22) 404' });
    const manager = new ToolchainManager(root, failing);
    manager.install('rust', 'stable');
    await manager.settled();
    await expect(stat(toolchainDir(root, 'rust', 'stable'))).rejects.toThrow();
    const version = (await manager.status())
      .find((p) => p.id === 'rust')
      ?.versions.find((v) => v.version === 'stable');
    expect(version?.installed).toBe(false);
    expect(version?.error).toContain('exit 22');
    expect(version?.error).toContain('404');
  });

  it('resolves the exact Go archive and checksum before running the script', async () => {
    const root = await dataRoot();
    const seen: Array<{ script: string; env: Record<string, string> }> = [];
    const manager = new ToolchainManager(root, okRunner(seen), async () => releases);
    manager.install('go', '1.23');
    await manager.settled();
    expect(seen[0]?.env['SENTRY_GO_FILE']).toBe('go1.23.8.linux-amd64.tar.gz');
    expect(seen[0]?.env['SENTRY_GO_SHA']).toBe('ccc');
  });

  it('rejects unknown packs and versions, and removes what is installed', async () => {
    const root = await dataRoot();
    const manager = new ToolchainManager(root, okRunner([]));
    expect(() => manager.install('cobol', '1')).toThrow(/Unknown toolchain/);
    expect(() => manager.install('python', '2.7')).toThrow(/Unknown Python version/);
    expect(() => manager.install('python', '../../etc')).toThrow();
    manager.install('java', '21');
    await manager.settled();
    expect((await manager.installed()).map((i) => i.packId)).toEqual(['java']);
    await manager.remove('java', '21');
    expect(await manager.installed()).toEqual([]);
  });

  it('builds PATH and variables from the newest installed version of each pack', async () => {
    const root = await dataRoot();
    const manager = new ToolchainManager(root, okRunner([]));
    manager.install('python', '3.11');
    manager.install('python', '3.13');
    manager.install('java', '17');
    await manager.settled();
    const { path, env } = await manager.environment();
    expect(path.some((p) => p.includes(join('python', '3.13')))).toBe(true);
    expect(path.some((p) => p.includes(join('python', '3.11')))).toBe(false);
    expect(path.some((p) => p.endsWith(join('jdk', 'bin')))).toBe(true);
    expect(env['JAVA_HOME']).toContain(join('java', '17'));
    expect(JSON.parse(await readFile(join(toolchainDir(root, 'java', '17'), '.installed.json'), 'utf8')).packId).toBe('java');
  });
});
