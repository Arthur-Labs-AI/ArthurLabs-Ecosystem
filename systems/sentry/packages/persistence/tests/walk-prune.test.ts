import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { copyTree, scanTree, walkTree } from '../src/filesystem.js';
import { DEFAULT_IMPORT_EXCLUSIONS, matchImportExclusion } from '../src/exclusions.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const exclude = (relativePath: string): boolean =>
  matchImportExclusion(relativePath, DEFAULT_IMPORT_EXCLUSIONS);

describe('walk/copy/scan exclusion pruning', () => {
  it('never descends into excluded directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-prune-'));
    roots.push(root);
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(1000));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;');
    const seen: string[] = [];
    for await (const entry of walkTree(root, { exclude })) seen.push(entry.relativePath);
    expect(seen).not.toContain('node_modules');
    expect(seen.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(seen).toContain('src/a.ts');
  });

  it('copyTree skips excluded subtrees and scanTree hashes only the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-prune-'));
    roots.push(root);
    const source = join(root, 'source');
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src', 'a.ts'), 'export const a = 1;');
    const dest = join(root, 'dest');
    const stats = await copyTree(source, dest, { exclude });
    expect(stats.fileCount).toBe(1);
    const scan = await scanTree(dest, { exclude });
    expect(scan.fileCount).toBe(1);
    const full = await scanTree(source);
    expect(full.fileCount).toBe(2);
    expect(scan.contentHash).not.toBe(full.contentHash);
  });
});
