import { describe, expect, it } from 'vitest';
import { doctorLines, versionLine } from '../src/index.js';

describe('qa cli', () => {
  it('--version prints qa version', () => {
    expect(versionLine()).toMatch(/^qa \d+\.\d+\.\d+$/);
  });
  it('doctor reports foundation OK and defers harnesses', () => {
    const lines = doctorLines();
    expect(lines.join('\n')).toContain('Domain       OK');
    expect(lines.join('\n')).toContain('not implemented in Phase 1');
  });
});
