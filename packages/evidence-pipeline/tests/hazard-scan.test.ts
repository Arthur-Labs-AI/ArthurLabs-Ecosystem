import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hazardModuleKey, scanHazardFiles, scoreHazards } from '../src/index.js';

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('hazard scan', () => {
  it('flags deletes and separator rewrites, and ignores plain code', () => {
    expect(scoreHazards("await rm(target, { recursive: true });").hazards).toEqual([
      'deletes files or directories',
    ]);
    expect(scoreHazards("p.replaceAll('\\\\', '/')").score).toBeGreaterThanOrEqual(4);
    expect(scoreHazards('export const add = (a, b) => a + b;').score).toBe(0);
  });

  it('ranks product source, skipping dependencies, builds and tests', async () => {
    root = await mkdtemp(join(tmpdir(), 'hazard-'));
    const files: Record<string, string> = {
      'packages/store/src/index.ts': "rmSync(path, { recursive: true }); name.replaceAll('\\\\', '/');",
      'packages/small/src/index.ts': "const h = createHash('sha256'); JSON.parse(text);",
      'packages/plain/src/index.ts': 'export const one = 1;',
      'packages/store/dist/index.js': 'rmSync(path);',
      'node_modules/dep/index.js': 'rmSync(path);',
      'packages/store/src/index.test.ts': 'rmSync(path);',
      'tests/helper.ts': 'rmSync(path);',
      'scripts/build.mjs': 'rmSync(path); name.replaceAll("\\\\", "/");',
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(root, name, '..'), { recursive: true });
      await writeFile(join(root, name), text);
    }
    const found = await scanHazardFiles(root);
    expect(found.map((f) => f.file)).toEqual([
      'packages/store/src/index.ts',
      'packages/small/src/index.ts',
    ]);
  });

  it('returns nothing for a missing directory', async () => {
    expect(await scanHazardFiles(join(tmpdir(), 'does-not-exist-hazard'))).toEqual([]);
  });

  it('names the package a probe would import', () => {
    expect(hazardModuleKey('packages/workspace-factory/src/index.ts')).toBe('workspace-factory');
    expect(hazardModuleKey('lib/cleanup.py')).toBe('cleanup');
    expect(hazardModuleKey('server/index.js')).toBe('server');
  });
});
