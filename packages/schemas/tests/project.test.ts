import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const base = {
  schemaVersion: 1,
  id: 'proj_01K7777777777777777777A8W1',
  name: 'Example',
  sourcePath: 'D:/Projects/AutoPulse',
  createdAt: T,
  updatedAt: T,
  metadata: { git: { detected: true } },
};

describe('ProjectSchema', () => {
  it('accepts a valid project', () => {
    expect(ProjectSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a missing name', () => {
    const { name: _unusedName, ...rest } = base;
    void _unusedName;
    expect(ProjectSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects non-UTC timestamps', () => {
    expect(ProjectSchema.safeParse({ ...base, createdAt: '09/09/2026' }).success).toBe(false);
  });
  it('accepts extended metadata', () => {
    const p = ProjectSchema.parse({
      ...base,
      metadata: {
        stack: { languages: ['ts'], frameworks: ['f'] },
        ciProviders: ['github_actions'],
      },
    });
    expect(p.metadata.ciProviders).toEqual(['github_actions']);
  });
  it('round-trips through JSON', () => {
    const p = ProjectSchema.parse(base);
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});
