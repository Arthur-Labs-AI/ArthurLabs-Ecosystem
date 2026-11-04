import { describe, expect, it } from 'vitest';
import { ProjectSnapshotSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const base = {
  schemaVersion: 1,
  id: 'snap_01K7777777777777777777A8W2',
  projectId: 'proj_01K7777777777777777777A8W1',
  projectRevisionId: 'rev_01K7777777777777777777A8W9',
  createdAt: T,
  sourceState: {},
  manifest: {
    entryCount: 1,
    fileCount: 1,
    directoryCount: 0,
    symlinkCount: 0,
    totalBytes: 10,
    artifactId: 'artifact_01K7777777777777777777A8WE',
  },
  contentHash: SHA,
};

describe('ProjectSnapshotSchema', () => {
  it('accepts a valid snapshot', () => {
    expect(ProjectSnapshotSchema.safeParse(base).success).toBe(true);
  });
  it('rejects negative manifest totals', () => {
    const bad = {
      ...base,
      manifest: { ...base.manifest, totalBytes: -1 },
    };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects invalid SHA', () => {
    const bad = { ...base, contentHash: 'zzz' };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects an inline unbounded entries array', () => {
    expect(
      ProjectSnapshotSchema.safeParse({ ...base, manifest: { ...base.manifest, entries: [] } })
        .success,
    ).toBe(false);
  });
  it('round-trips through JSON', () => {
    const s = ProjectSnapshotSchema.parse(base);
    expect(ProjectSnapshotSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
