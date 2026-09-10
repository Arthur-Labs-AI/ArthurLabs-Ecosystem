import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
});
