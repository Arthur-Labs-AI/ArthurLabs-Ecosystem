import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectRevisionSchema, ProjectSchema } from '@qa/schemas';
import { ProjectContextBuilder } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('ProjectContextBuilder', () => {
  it('indexes generic materials and reports only evidence-backed stack facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-context-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const projectRoot = join(root, 'project');
    await mkdir(join(projectRoot, 'docs'), { recursive: true });
    await writeFile(join(projectRoot, 'README.md'), '# Example\n\nA factual example service.');
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { react: '1' }, devDependencies: { vitest: '2' } }),
    );
    await writeFile(join(projectRoot, 'unknown.custom'), 'opaque but still indexed');
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const timestamp = '2026-09-10T19:00:00.000Z';
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'proj_01K7777777777777777777A8W1',
      name: 'Example',
      sourcePath: projectRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {},
    });
    const revision = ProjectRevisionSchema.parse({
      schemaVersion: 1,
      id: 'rev_01K7777777777777777777A8W9',
      projectId: project.id,
      sourcePath: projectRoot,
      importedAt: timestamp,
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    repository.saveProject(project);
    repository.saveRevision(revision);
    const context = await new ProjectContextBuilder(dataRoot, repository).build({
      projectId: project.id,
      projectRevisionId: revision.id,
      workingCopyPath: projectRoot,
    });
    expect(context.purpose).toBe('A factual example service.');
    expect(context.architectureSummary).toBeUndefined();
    expect(context.detectedStack?.frameworks).toContain('React');
    expect(context.detectedStack?.testFrameworks).toContain('Vitest');
    expect(repository.getContext(context.id)).toEqual(context);
    database.close();
  });
});
