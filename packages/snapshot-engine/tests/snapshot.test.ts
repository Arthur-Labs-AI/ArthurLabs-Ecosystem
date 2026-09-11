import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { scanTree } from '../src/index.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'sentry-snapshot-'));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('streaming deterministic snapshots', () => {
  it('produces stable order and content hashes for many files', async () => {
    const project = await root();
    await mkdir(join(project, 'nested'));
    for (let index = 39; index >= 0; index -= 1) {
      await writeFile(
        join(project, 'nested', String(index).padStart(2, '0') + '.txt'),
        'value-' + index,
      );
    }
    const firstLines: string[] = [];
    const first = await scanTree(project, { onEntry: (_entry, line) => firstLines.push(line) });
    const secondLines: string[] = [];
    const second = await scanTree(project, { onEntry: (_entry, line) => secondLines.push(line) });
    expect(first).toEqual(second);
    expect(first.fileCount).toBe(40);
    expect(first.entryCount).toBe(41);
    expect(firstLines).toEqual(secondLines);
    expect(firstLines.join('')).toContain('nested/00.txt');
  });

  it('hashes symlink targets without following them when supported', async () => {
    const project = await root();
    await writeFile(join(project, 'target.txt'), 'target');
    try {
      await symlink('target.txt', join(project, 'link.txt'));
    } catch (cause) {
      if (process.platform === 'win32') return;
      throw cause;
    }
    const lines: string[] = [];
    const scan = await scanTree(project, { onEntry: (_entry, line) => lines.push(line) });
    expect(scan.symlinkCount).toBe(1);
    expect(scan.fileCount).toBe(1);
    expect(lines.join('')).toContain('"linkScope":"internal"');
    expect(lines.join('')).toContain('"linkTarget":"target.txt"');
  });

  it('classifies external, broken, and cyclic links deterministically', async () => {
    const container = await root();
    const project = join(container, 'project');
    await mkdir(project);
    await writeFile(join(container, 'external.txt'), 'outside');
    try {
      await symlink('../external.txt', join(project, 'external.txt'));
      await symlink('missing.txt', join(project, 'broken.txt'));
      await symlink('cycle-b.txt', join(project, 'cycle-a.txt'));
      await symlink('cycle-a.txt', join(project, 'cycle-b.txt'));
    } catch (cause) {
      if (process.platform === 'win32') return;
      throw cause;
    }
    const first: string[] = [];
    const second: string[] = [];
    const firstScan = await scanTree(project, { onEntry: (_entry, line) => first.push(line) });
    const secondScan = await scanTree(project, { onEntry: (_entry, line) => second.push(line) });
    expect(firstScan.contentHash).toBe(secondScan.contentHash);
    expect(first).toEqual(second);
    expect(first.join('')).toContain('"linkScope":"external"');
    expect(first.join('')).toContain('"linkScope":"broken"');
  });
});
