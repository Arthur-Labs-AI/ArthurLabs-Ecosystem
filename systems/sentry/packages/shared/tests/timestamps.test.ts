import { describe, expect, it } from 'vitest';
import { isIsoTimestamp } from '../src/index.js';

describe('isIsoTimestamp', () => {
  it('accepts real UTC calendar timestamps only', () => {
    expect(isIsoTimestamp('2026-09-09T19:00:00.000Z')).toBe(true);
    expect(isIsoTimestamp('2026-09-09T21:00:00+02:00')).toBe(false);
    expect(isIsoTimestamp('2026-02-30T12:00:00Z')).toBe(false);
    expect(isIsoTimestamp('2026-99-99T99:99:99Z')).toBe(false);
    expect(isIsoTimestamp('9/9/2026 19:00')).toBe(false);
  });
});
