import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
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
    expect(await lstat(join(workspace.runtimePath, 'escape.txt.sentry-link.json'))).toBeDefined();
    expect(await lstat(join(workspace.runtimePath, 'broken.txt.sentry-link.json'))).toBeDefined();
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
});
