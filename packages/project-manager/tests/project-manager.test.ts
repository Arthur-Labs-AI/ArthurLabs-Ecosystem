import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, projectDataPaths, scanTree } from '@qa/persistence';
import { ProjectManager, ProjectManagerError } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-project-manager-'));
  roots.push(root);
  const source = join(root, 'Source Project ü');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, '.git'), { recursive: true });
  await mkdir(join(source, 'node_modules', 'fixture'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Example\n\nFactual sample purpose.');
  await writeFile(join(source, '.hidden'), 'hidden');
  await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
  await writeFile(join(source, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  return {
    root,
    source,
    dataRoot,
    database,
    repository,
    manager: new ProjectManager(dataRoot, repository),
  };
}

describe('managed project lifecycle', () => {
  it('imports the complete source, locks mutations, and preserves original content', async () => {
    const f = await fixture();
    const original = await scanTree(f.source);
    const added = await f.manager.addProject(f.source);
    const paths = projectDataPaths(f.dataRoot, added.project.id);
    expect(await readFile(join(paths.workingCopy, '.hidden'), 'utf8')).toBe('hidden');
    expect(await readFile(join(paths.workingCopy, '.git', 'HEAD'), 'utf8')).toContain(
      'refs/heads/main',
    );
    expect(
      await readFile(join(paths.workingCopy, 'node_modules', 'fixture', 'index.js'), 'utf8'),
    ).toContain('module.exports');
    expect(added.context?.purpose).toBe('Factual sample purpose.');
    expect((await scanTree(f.source)).contentHash).toBe(original.contentHash);

    const runId = 'run_01K7777777777777777777A8W3';
    f.manager.lockProjectForRun(added.project.id, runId);
    await expect(f.manager.updateProjectCopy(added.project.id)).rejects.toMatchObject({
      code: 'PROJECT_LOCKED',
    });
    f.manager.unlockProjectAfterRun(added.project.id, runId);
    f.database.close();
  });

  it('creates a new revision while cancelled updates preserve the healthy copy', async () => {
    const f = await fixture();
    const added = await f.manager.addProject(f.source);
    await writeFile(join(f.source, 'README.md'), '# Example\n\nVersion two.');
    const updated = await f.manager.updateProjectCopy(added.project.id);
    expect(updated.revision.id).not.toBe(added.revision.id);
    expect(updated.revision.contentHash).not.toBe(added.revision.contentHash);
    expect(f.repository.listRevisions(added.project.id)).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    await expect(
      f.manager.updateProjectCopy(added.project.id, undefined, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ProjectManagerError);
    expect(f.manager.getProject(added.project.id)?.revision.id).toBe(updated.revision.id);
    expect(
      await readFile(
        join(projectDataPaths(f.dataRoot, added.project.id).workingCopy, 'README.md'),
        'utf8',
      ),
    ).toContain('Version two');
    f.database.close();
  });

  it('rejects importing a source that contains the Sentry data root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-overlap-'));
    roots.push(root);
    const source = join(root, 'source');
    const dataRoot = join(source, '.sentry-data');
    await mkdir(dataRoot, { recursive: true });
    const database = new SentryDatabase({ dataRoot });
    const manager = new ProjectManager(dataRoot, new SentryRepository(database));
    await expect(manager.addProject(source)).rejects.toMatchObject({
      code: 'PROJECT_PATH_OVERLAP',
    });
    database.close();
  });

  it('restores the recorded copy after a crash during update promotion', async () => {
    const f = await fixture();
    const added = await f.manager.addProject(f.source);
    const paths = projectDataPaths(f.dataRoot, added.project.id);
    const backup = join(paths.root, 'working-copy.backup');
    await rename(paths.workingCopy, backup);
    await mkdir(paths.workingCopy);
    await writeFile(join(paths.workingCopy, 'README.md'), 'uncommitted promoted copy');
    f.repository.saveManagedCopy({
      ...added.managedCopy,
      state: 'updating',
    });

    await f.manager.recoverInterruptedUpdates();

    expect(await readFile(join(paths.workingCopy, 'README.md'), 'utf8')).toContain(
      'Factual sample purpose',
    );
    expect(f.manager.getManagedCopy(added.project.id).state).toBe('ready');
    f.database.close();
  });
});
