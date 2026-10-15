import { matchImportExclusion } from '@qa/persistence';

// Source selection is separate from the frozen v2 hash exclusions. Changing
// the latter would invalidate existing revisions which retained these bytes.
const GENERATED_DIRECTORIES = new Set([
  '.pytest_cache',
  '.pytest-tmp',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.tmp',
  '.next',
  '.nuxt',
]);

export function excludeGeneratedSource(relativePath: string): boolean {
  if (matchImportExclusion(relativePath)) return true;
  return relativePath
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => {
      const name = segment.toLowerCase();
      return GENERATED_DIRECTORIES.has(name) || name.startsWith('.pytest-tmp-');
    });
}
