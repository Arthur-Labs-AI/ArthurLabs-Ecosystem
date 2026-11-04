import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectProfile } from '@qa/schemas';
import { createProjectId, createProjectRevisionId } from '@qa/shared';
import { ProjectProfileStore, projectDataPaths } from '../src/index.js';

const roots: string[] = [];
const dataRoot = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), 'sentry-profile-'));
  roots.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const projectId = createProjectId();
const profile = (overrides: Partial<ProjectProfile> = {}): ProjectProfile => ({
  schemaVersion: 1,
  projectId,
  agentStackId: 'stack_opencode_main' as never,
  projectRevisionId: createProjectRevisionId(),
  contentHash: 'sha256:abc',
  text: 'Entry points: apps/cli. Build: pnpm build.',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('ProjectProfileStore', () => {
  it('round-trips a profile and keeps agents apart', async () => {
    const store = new ProjectProfileStore(await dataRoot());
    const mine = profile();
    const other = profile({ agentStackId: 'stack_deepseek_main' as never, text: 'Other view.' });
    await store.write(mine);
    await store.write(other);
    expect(await store.read(projectId, mine.agentStackId)).toEqual(mine);
    expect((await store.read(projectId, other.agentStackId))?.text).toBe('Other view.');
  });

  it('returns undefined when missing, corrupt or written for another agent', async () => {
    const root = await dataRoot();
    const store = new ProjectProfileStore(root);
    expect(await store.read(projectId, 'stack_opencode_main' as never)).toBeUndefined();
    const folder = join(projectDataPaths(root, projectId).root, 'profiles');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'stack_opencode_main.json'), '{not json', 'utf8');
    expect(await store.read(projectId, 'stack_opencode_main' as never)).toBeUndefined();
    await writeFile(
      join(folder, 'stack_deepseek_main.json'),
      JSON.stringify(profile({ agentStackId: 'stack_opencode_main' as never })),
      'utf8',
    );
    expect(await store.read(projectId, 'stack_deepseek_main' as never)).toBeUndefined();
  });

  it('replaces atomically and removes', async () => {
    const root = await dataRoot();
    const store = new ProjectProfileStore(root);
    await store.write(profile({ text: 'first' }));
    await store.write(profile({ text: 'second' }));
    expect((await store.read(projectId, 'stack_opencode_main' as never))?.text).toBe('second');
    const folder = join(projectDataPaths(root, projectId).root, 'profiles');
    expect(await readFile(join(folder, 'stack_opencode_main.json'), 'utf8')).toContain('second');
    await store.remove(projectId, 'stack_opencode_main' as never);
    expect(await store.read(projectId, 'stack_opencode_main' as never)).toBeUndefined();
  });

  it('refuses an oversized profile', async () => {
    const store = new ProjectProfileStore(await dataRoot());
    await expect(store.write(profile({ text: 'x'.repeat(9000) }))).rejects.toThrow();
  });
});
