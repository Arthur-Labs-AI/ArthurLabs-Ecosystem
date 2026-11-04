import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_EXCLUSIONS, matchImportExclusion } from '../src/exclusions.js';

describe('import exclusion matcher', () => {
  it('excludes well-known directories at any depth', () => {
    for (const name of DEFAULT_IMPORT_EXCLUSIONS.directories) {
      expect(matchImportExclusion(name)).toBe(true);
      expect(matchImportExclusion('packages/foo/' + name)).toBe(true);
      expect(matchImportExclusion(name + '/HEAD')).toBe(true);
      expect(matchImportExclusion('packages/foo/' + name + '/bar.txt')).toBe(true);
    }
  });

  it('matches case variants of well-known names', () => {
    expect(matchImportExclusion('Dist')).toBe(true);
    expect(matchImportExclusion('a/BUILD/output.js')).toBe(true);
    expect(matchImportExclusion('NODE_MODULES/pkg/index.js')).toBe(true);
  });

  it('excludes junk files but keeps real sources', () => {
    expect(matchImportExclusion('.DS_Store')).toBe(true);
    expect(matchImportExclusion('logs/debug.log')).toBe(true);
    expect(matchImportExclusion('src/index.ts')).toBe(false);
    expect(matchImportExclusion('README.md')).toBe(false);
    expect(matchImportExclusion('package.json')).toBe(false);
    expect(matchImportExclusion('src/catalog.ts')).toBe(false);
    expect(matchImportExclusion('distribution-plan.md')).toBe(false);
    expect(matchImportExclusion('')).toBe(false);
  });

  it('does not match partial directory names', () => {
    expect(matchImportExclusion('src/mydist/file.ts')).toBe(false);
    expect(matchImportExclusion('src/distribution/plan.md')).toBe(false);
    expect(matchImportExclusion('my-node_modules-clone/a.ts')).toBe(false);
  });

  it('normalizes windows separators before matching', () => {
    expect(matchImportExclusion('packages\\foo\\node_modules\\bar.js')).toBe(true);
    expect(matchImportExclusion('src\\index.ts')).toBe(false);
  });
});
