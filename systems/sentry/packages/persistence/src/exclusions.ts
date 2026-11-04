/** Default import exclusion set: directory/file names that carry no QA
 *  value but dominate copy/scan wall-clock on large repos (node_modules,
 *  .git, build output, harness-local state). The matcher is pure,
 *  case-aware for the well-known names, separator-normalized, and matches
 *  on the entry's own relative path — symlinks are never resolved. */

export interface ImportExclusionSet {
  readonly version: 2;
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

const DIRECTORY_NAMES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.pnpm-store',
  '.sentry-live',
  '.tmp-sentry-test-fixtures',
  '.ai-harness',
  '.superharness',
] as const;

const FILE_NAMES = ['.DS_Store'] as const;

const FILE_SUFFIXES = ['.log'] as const;

export const DEFAULT_IMPORT_EXCLUSIONS: ImportExclusionSet = {
  version: 2,
  directories: DIRECTORY_NAMES,
  files: [...FILE_NAMES, ...FILE_SUFFIXES.map((suffix) => '*' + suffix)],
};

function lowercaseVariants(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    out.add(name);
    const lower = name.toLowerCase();
    if (lower !== name) out.add(lower);
  }
  return out;
}

const EXCLUDED_DIRECTORIES = lowercaseVariants(DIRECTORY_NAMES);

/** True when a walk/copy/scan entry must be skipped. Segments are matched
 *  at any depth (`packages/foo/node_modules` excluded); a matching
 *  directory prunes the whole subtree. */
export function matchImportExclusion(
  relativePath: string,
  exclusions: ImportExclusionSet = DEFAULT_IMPORT_EXCLUSIONS,
): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((part) => part.length > 0);
  if (segments.length === 0) return false;
  const directorySet =
    exclusions === (DEFAULT_IMPORT_EXCLUSIONS as ImportExclusionSet)
      ? EXCLUDED_DIRECTORIES
      : new Set<string>(
          exclusions.directories.flatMap((name) =>
            name.toLowerCase() === name ? [name] : [name, name.toLowerCase()],
          ),
        );
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    if (directorySet.has(segment) || directorySet.has(segment.toLowerCase())) return true;
    if (index === segments.length - 1) {
      if ((FILE_NAMES as readonly string[]).includes(segment)) return true;
      const lower = segment.toLowerCase();
      for (const suffix of FILE_SUFFIXES) {
        if (lower.endsWith(suffix)) return true;
      }
    }
  }
  return false;
}
