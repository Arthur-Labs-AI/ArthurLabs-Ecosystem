import { describe, expect, it } from 'vitest';
import { createFindingId, createProjectId, isFindingId, isProjectId } from '../src/index.js';

describe('ids', () => {
  it('generates prefixed opaque ids', () => {
    expect(isProjectId(createProjectId())).toBe(true);
    expect(isFindingId(createFindingId())).toBe(true);
  });
  it('brands prevent cross-use', () => {
    expect(isProjectId(createFindingId())).toBe(false);
  });
});
