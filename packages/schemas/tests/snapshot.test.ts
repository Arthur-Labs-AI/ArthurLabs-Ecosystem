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
    entries: [{ relativePath: 'src/index.ts', sha256: SHA, sizeBytes: 10, type: 'file' }],
  },
  contentHash: SHA,
};

describe('ProjectSnapshotSchema', () => {
  it('accepts a valid snapshot', () => {
    expect(ProjectSnapshotSchema.safeParse(base).success).toBe(true);
  });
  it('rejects negative file size', () => {
    const bad = {
      ...base,
      manifest: { entries: [{ relativePath: 'a.ts', sha256: SHA, sizeBytes: -1, type: 'file' }] },
    };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects invalid SHA', () => {
    const bad = { ...base, contentHash: 'zzz' };
    expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects absolute file paths', () => {
    for (const p of ['C:/x.ts', '/home/x.ts']) {
      const bad = {
        ...base,
        manifest: { entries: [{ relativePath: p, sha256: SHA, sizeBytes: 1, type: 'file' }] },
      };
      expect(ProjectSnapshotSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('accepts all file types', () => {
    for (const t of ['file', 'directory', 'symlink'] as const) {
      const v = {
        ...base,
        manifest: { entries: [{ relativePath: 'a', sha256: SHA, sizeBytes: 0, type: t }] },
      };
      expect(ProjectSnapshotSchema.safeParse(v).success).toBe(true);
    }
  });
  it('round-trips through JSON', () => {
    const s = ProjectSnapshotSchema.parse(base);
    expect(ProjectSnapshotSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
