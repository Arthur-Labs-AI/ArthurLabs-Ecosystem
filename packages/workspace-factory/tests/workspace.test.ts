import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFactory } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('WorkspaceFactory', () => {
  it('creates independently writable copies without mutable hardlinks', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-workspaces-'));
    roots.push(dataRoot);
    const baseline = join(dataRoot, 'baseline');
    await mkdir(join(baseline, 'src'), { recursive: true });
    await writeFile(join(baseline, 'src', 'value.txt'), 'A');
    const factory = new WorkspaceFactory(dataRoot, true);
    const common = {
      projectId: 'proj_01K7777777777777777777A8W1',
      qaRunId: 'run_01K7777777777777777777A8W3',
      snapshotId: 'snap_01K7777777777777777777A8W2',
      workingCopyPath: baseline,
    } as const;
    const muse = await factory.create({
      ...common,
      agentRunId: 'arun_01K7777777777777777777A8W4',
    });
    const deepseek = await factory.create({
      ...common,
      agentRunId: 'arun_01K7777777777777777777A8W5',
    });
    await writeFile(join(muse.runtimePath, 'src', 'value.txt'), 'MUSE');
    expect(await readFile(join(baseline, 'src', 'value.txt'), 'utf8')).toBe('A');
    expect(await readFile(join(deepseek.runtimePath, 'src', 'value.txt'), 'utf8')).toBe('A');
    expect(await readFile(join(muse.runtimePath, 'src', 'value.txt'), 'utf8')).toBe('MUSE');
  });

  it('refuses cleanup paths outside the configured data root', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-workspaces-'));
    roots.push(dataRoot);
    const outside = await mkdtemp(join(tmpdir(), 'sentry-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    const result = await new WorkspaceFactory(dataRoot).cleanup({
      runtimePath: outside,
      snapshotId: 'snap_01K7777777777777777777A8W2',
      writable: true,
      isolated: true,
    });
    expect(result.cleaned).toBe(false);
    expect(result.warning).toContain('PATH_ESCAPE');
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('keeps internal links local and makes external links inert', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-workspaces-'));
    roots.push(dataRoot);
    const baseline = join(dataRoot, 'baseline');
    const external = join(dataRoot, 'external.txt');
    await mkdir(baseline);
    await writeFile(join(baseline, 'target.txt'), 'baseline');
    await writeFile(external, 'external');
    try {
      await symlink('target.txt', join(baseline, 'internal.txt'));
      await symlink('../external.txt', join(baseline, 'escape.txt'));
      await symlink('missing.txt', join(baseline, 'broken.txt'));
    } catch (cause) {
      if (process.platform === 'win32') return;
      throw cause;
    }
    const workspace = await new WorkspaceFactory(dataRoot, true).create({
      projectId: 'proj_01K7777777777777777777A8W1',
      qaRunId: 'run_01K7777777777777777777A8W3',
      agentRunId: 'arun_01K7777777777777777777A8W4',
      snapshotId: 'snap_01K7777777777777777777A8W2',
      workingCopyPath: baseline,
    });

    await writeFile(join(workspace.runtimePath, 'internal.txt'), 'workspace');
    expect(await readFile(join(workspace.runtimePath, 'target.txt'), 'utf8')).toBe('workspace');
    expect(await readFile(join(baseline, 'target.txt'), 'utf8')).toBe('baseline');
    const metadataRoot = join(dirname(workspace.runtimePath), '.sentry-workspace', 'blocked-links');
    expect(await readdir(metadataRoot)).toHaveLength(2);
    await writeFile(join(workspace.runtimePath, 'escape.txt'), 'local replacement');
    expect(await readFile(external, 'utf8')).toBe('external');
  });

  it('rewrites an absolute internal link away from the managed baseline', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-workspaces-'));
    roots.push(dataRoot);
    const baseline = join(dataRoot, 'baseline');
    await mkdir(baseline);
    const target = join(baseline, 'target.txt');
    await writeFile(target, 'baseline');
    try {
      await symlink(target, join(baseline, 'absolute.txt'));
    } catch (cause) {
      if (process.platform === 'win32') return;
      throw cause;
    }
    const workspace = await new WorkspaceFactory(dataRoot, true).create({
      projectId: 'proj_01K7777777777777777777A8W1',
      qaRunId: 'run_01K7777777777777777777A8W3',
      agentRunId: 'arun_01K7777777777777777777A8W4',
      snapshotId: 'snap_01K7777777777777777777A8W2',
      workingCopyPath: baseline,
    });
    expect(await readlink(join(workspace.runtimePath, 'absolute.txt'))).not.toBe(target);
    await writeFile(join(workspace.runtimePath, 'absolute.txt'), 'workspace');
    expect(await readFile(target, 'utf8')).toBe('baseline');
  });

  it('stores blocked-link metadata in a collision-free workspace namespace', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-workspaces-'));
    roots.push(dataRoot);
    const baseline = join(dataRoot, 'baseline');
    const external = join(dataRoot, 'external.txt');
    await mkdir(join(baseline, 'nested'), { recursive: true });
    await writeFile(external, 'external');
    await writeFile(join(baseline, 'foo.sentry-link.json'), 'legitimate content');
    try {
      await symlink('../external.txt', join(baseline, 'foo'));
      await symlink('../../external.txt', join(baseline, 'nested', 'escape'));
    } catch (cause) {
      if (process.platform === 'win32') return;
      throw cause;
    }

    const workspace = await new WorkspaceFactory(dataRoot, true).create({
      projectId: 'proj_01K7777777777777777777A8W1',
      qaRunId: 'run_01K7777777777777777777A8W3',
      agentRunId: 'arun_01K7777777777777777777A8W4',
      snapshotId: 'snap_01K7777777777777777777A8W2',
      workingCopyPath: baseline,
    });

    expect(await readFile(join(workspace.runtimePath, 'foo.sentry-link.json'), 'utf8')).toBe(
      'legitimate content',
    );
    await expect(lstat(join(workspace.runtimePath, 'foo'))).rejects.toThrow();
    await expect(lstat(join(workspace.runtimePath, 'nested', 'escape'))).rejects.toThrow();

    const metadataRoot = join(dirname(workspace.runtimePath), '.sentry-workspace', 'blocked-links');
    const metadataFiles = (await readdir(metadataRoot)).sort();
    expect(metadataFiles).toHaveLength(2);
    const metadata = await Promise.all(
      metadataFiles.map(
        async (name) =>
          JSON.parse(await readFile(join(metadataRoot, name), 'utf8')) as {
            relativePath: string;
            linkTarget: string;
            linkScope: string;
            reason: string;
          },
      ),
    );
    expect(metadata.map((item) => item.relativePath).sort()).toEqual(['foo', 'nested/escape']);
    expect(metadata.every((item) => item.linkTarget.length > 0)).toBe(true);
    expect(metadata.every((item) => item.linkScope === 'external')).toBe(true);
    expect(metadata.every((item) => item.reason.length > 0)).toBe(true);
  });
});
