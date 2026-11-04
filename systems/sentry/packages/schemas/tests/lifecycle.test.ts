import { describe, expect, it } from 'vitest';
import { ManagedProjectCopySchema, ProjectRevisionSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const revision = {
  schemaVersion: 1,
  id: 'rev_01K7777777777777777777A8W9',
  projectId: 'proj_01K7777777777777777777A8W1',
  sourcePath: 'D:/Projects/Example',
  importedAt: T,
  contentHash: SHA,
  stats: { fileCount: 12, directoryCount: 4, totalBytes: Number.MAX_SAFE_INTEGER },
  sourceState: {
    git: { detected: true, branch: 'main', headCommit: 'abc123', dirty: false },
  },
};

describe('project lifecycle schemas', () => {
  it('accepts an immutable revision without imposing a project-size cap', () => {
    expect(ProjectRevisionSchema.safeParse(revision).success).toBe(true);
    expect(
      ProjectRevisionSchema.safeParse({
        ...revision,
        stats: { fileCount: 12, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
      }).success,
    ).toBe(false);
  });

  it('requires run and runtime owners exactly while a managed copy is locked', () => {
    const base = {
      schemaVersion: 1,
      projectId: revision.projectId,
      currentRevisionId: revision.id,
      updatedAt: T,
    };
    expect(ManagedProjectCopySchema.safeParse({ ...base, state: 'ready' }).success).toBe(true);
    expect(
      ManagedProjectCopySchema.safeParse({
        schemaVersion: 1,
        projectId: revision.projectId,
        state: 'ready',
        updatedAt: T,
      }).success,
    ).toBe(false);
    expect(ManagedProjectCopySchema.safeParse({ ...base, state: 'locked_for_run' }).success).toBe(
      false,
    );
    expect(
      ManagedProjectCopySchema.safeParse({
        ...base,
        state: 'locked_for_run',
        lockedByQARunId: 'run_01K7777777777777777777A8W3',
        runtimeInstanceId: 'runtime_01K7777777777777777777A8W2',
      }).success,
    ).toBe(true);
    expect(
      ManagedProjectCopySchema.safeParse({
        ...base,
        state: 'updating',
        lockedByQARunId: 'run_01K7777777777777777777A8W3',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown lifecycle fields and versions', () => {
    expect(ProjectRevisionSchema.safeParse({ ...revision, surprise: true }).success).toBe(false);
    expect(ProjectRevisionSchema.safeParse({ ...revision, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects malformed revision identity, project identity, hash, time, and stats', () => {
    for (const invalid of [
      { ...revision, id: 'snap_01K7777777777777777777A8W9' },
      { ...revision, projectId: 'run_01K7777777777777777777A8W3' },
      { ...revision, contentHash: 'not-a-hash' },
      { ...revision, importedAt: 'yesterday' },
      { ...revision, stats: { fileCount: -1, totalBytes: 1 } },
      { ...revision, sourceContent: 'embedded project bytes' },
      { ...revision, maxProjectSize: 1000 },
    ]) {
      expect(ProjectRevisionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
