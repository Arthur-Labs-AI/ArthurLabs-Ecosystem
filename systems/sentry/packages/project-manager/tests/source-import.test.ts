import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeInstanceLease,
  SentryDatabase,
  SentryRepository,
  projectDataPaths,
  scanTree,
} from '@qa/persistence';
import { ProjectManager } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-source-import-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'main.py'), 'print("source")');
  const database = new SentryDatabase({ dataRoot: join(root, 'data') });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  return {
    source,
    database,
    repository,
    dataRoot: join(root, 'data'),
    manager: new ProjectManager(join(root, 'data'), repository, { runtimeLease: lease }),
  };
}
const generated = [
  '.pytest_cache',
  '.pytest-tmp',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  '.venv',
  '.cache',
  '.tmp',
  'apps/web/.next',
  'apps/web/.nuxt',
];

describe('source import selection and errors', () => {
  it('prunes incremental build state on new imports without changing v2 integrity rules', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.source, 'tsconfig.tsbuildinfo'), 'old compiler state');
      const fresh = await f.manager.addProject(f.source);
      const freshCopy = projectDataPaths(f.dataRoot, fresh.project.id).workingCopy;
      await expect(stat(join(freshCopy, 'tsconfig.tsbuildinfo'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await f.manager.assertWorkingCopyIntegrity(fresh.project.id);
      const legacy = await f.manager.addProject(f.source, { includeAll: true });
      f.repository.saveRevision({ ...legacy.revision, hashVersion: 2 });
      await f.manager.assertWorkingCopyIntegrity(legacy.project.id);
      const legacyCopy = projectDataPaths(f.dataRoot, legacy.project.id).workingCopy;
      expect(await readFile(join(legacyCopy, 'tsconfig.tsbuildinfo'), 'utf8')).toBe(
        'old compiler state',
      );
    } finally {
      f.database.close();
    }
  });
  it('prunes Python caches/environments and web build output on import and update', async () => {
    const f = await fixture();
    try {
      for (const name of generated) {
        await mkdir(join(f.source, name), { recursive: true });
        await writeFile(join(f.source, name, 'generated.bin'), 'generated');
      }
      const added = await f.manager.addProject(f.source);
      const copy = projectDataPaths(f.dataRoot, added.project.id).workingCopy;
      for (const name of generated) {
        await expect(stat(join(copy, name))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(join(copy, 'main.py'), 'utf8')).toContain('source');
      await f.manager.assertWorkingCopyIntegrity(added.project.id);
      await writeFile(join(f.source, 'main.py'), 'print("updated")');
      await f.manager.updateProjectCopy(added.project.id);
      await f.manager.assertWorkingCopyIntegrity(added.project.id);
      for (const name of generated) {
        await expect(stat(join(copy, name))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      f.database.close();
    }
  });

  it('keeps caches in includeAll and preserves an existing v2 revision containing them', async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.source, '.pytest_cache'));
      await writeFile(join(f.source, '.pytest_cache', 'state'), 'legacy bytes');
      const added = await f.manager.addProject(f.source, { includeAll: true });
      f.repository.saveRevision({ ...added.revision, hashVersion: 2 });
      await f.manager.assertWorkingCopyIntegrity(added.project.id);
      const copy = projectDataPaths(f.dataRoot, added.project.id).workingCopy;
      expect((await scanTree(copy)).contentHash).toBe(added.revision.contentHash);
      await writeFile(join(copy, '.pytest_cache', 'state'), 'changed');
      await expect(f.manager.assertWorkingCopyIntegrity(added.project.id)).rejects.toMatchObject({
        code: 'PROJECT_COPY_DRIFT',
      });
    } finally {
      f.database.close();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'prunes an unreadable pytest cache but reports unreadable required source with its path',
    async () => {
      const f = await fixture();
      const cache = join(f.source, '.pytest_cache');
      const file = join(f.source, 'main.py');
      await mkdir(cache);
      await chmod(cache, 0);
      try {
        const added = await f.manager.addProject(f.source);
        expect(added.revision.stats?.fileCount).toBe(1);
        await chmod(file, 0);
        await expect(f.manager.addProject(f.source)).rejects.toMatchObject({
          code: 'PROJECT_SOURCE_UNREADABLE',
          message: expect.stringContaining('main.py'),
        });
        expect(f.repository.listProjects()).toHaveLength(1);
      } finally {
        await chmod(cache, 0o700);
        await chmod(file, 0o600);
        f.database.close();
      }
    },
  );
});
