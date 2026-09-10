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
    const scan = await scanTree(project);
    expect(scan.symlinkCount).toBe(1);
    expect(scan.fileCount).toBe(1);
  });
});
