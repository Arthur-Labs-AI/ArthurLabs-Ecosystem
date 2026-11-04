import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** A source file whose operations deserve a hostile probe, found without asking the model. */
export interface HazardFile {
  /** Path relative to the scanned root, always with forward slashes. */
  readonly file: string;
  /** Short human labels of the risky operation kinds found in it. */
  readonly hazards: readonly string[];
  readonly score: number;
}

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'venv',
  'docs',
  'test',
  'tests',
  '__tests__',
  '__pycache__',
  'fixtures',
  // build, release and UI glue: rarely where a product data defect lives
  'scripts',
  'renderer',
]);
const DELETES_LABEL = 'deletes files or directories';
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs)$/i;
const NON_PRODUCT_FILE = /(?:[._-](?:test|spec)\.|\.d\.ts$|\.config\.)/i;
const MAX_FILE_BYTES = 150_000;
const MAX_FILES_SCANNED = 4000;
const MAX_DEPTH = 8;
/** A file needs at least this much weight (two kinds of operation, or one dangerous kind). */
const MIN_SCORE = 4;

interface HazardPattern {
  readonly label: string;
  readonly weight: number;
  readonly pattern: RegExp;
}

// Language-neutral on purpose: the patterns name operations, not frameworks.
const HAZARD_PATTERNS: readonly HazardPattern[] = [
  {
    label: DELETES_LABEL,
    weight: 4,
    pattern:
      /\b(?:rmSync|rmdirSync|unlinkSync|rmdir|unlink|removeSync|rmtree|remove_dir_all|RemoveAll|os\.remove|fs\.rm|fsp\.rm|rm)\s*\(/,
  },
  {
    label: 'rewrites path separators or names',
    weight: 4,
    pattern:
      /replace(?:All)?\(\s*(?:'\\\\'|"\\\\"|\/\\\\\/|['"]\/['"])|\b(?:path\.sep|os\.sep|PATH_SEPARATOR)\b/,
  },
  {
    label: 'decides containment by prefix or relative path',
    weight: 2,
    pattern: /\.startsWith\(|\brelative\([^)]*\)|\.\.\/|\bis_relative_to\b|\bHasPrefix\b/,
  },
  {
    label: 'parses or deserializes text',
    weight: 2,
    pattern: /\b(?:JSON\.parse|yaml\.(?:safe_)?load|Unmarshal|unmarshal|deserialize)\b/,
  },
  {
    label: 'hashes or fingerprints content',
    weight: 2,
    pattern: /\b(?:createHash|hashlib|sha256|sha1|md5)\b/,
  },
];

/** Deleting code is where one wrong argument loses data, so it is probed first. */
export function deletesData(file: HazardFile): boolean {
  return file.hazards.includes(DELETES_LABEL);
}

export function scoreHazards(source: string): { hazards: string[]; score: number } {
  const hazards: string[] = [];
  let score = 0;
  for (const { label, weight, pattern } of HAZARD_PATTERNS) {
    if (!pattern.test(source)) continue;
    hazards.push(label);
    score += weight;
  }
  return { hazards, score };
}

async function* walk(directory: string, depth: number): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* walk(full, depth + 1);
    } else if (
      entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !NON_PRODUCT_FILE.test(entry.name)
    ) {
      yield full;
    }
  }
}

/**
 * Product source files ranked by how much risky behaviour they contain. Never
 * throws: an unreadable tree simply yields fewer files.
 */
export async function scanHazardFiles(root: string, limit = 40): Promise<HazardFile[]> {
  const found: HazardFile[] = [];
  let scanned = 0;
  for await (const path of walk(root, 0)) {
    scanned += 1;
    if (scanned > MAX_FILES_SCANNED) break;
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (source.length > MAX_FILE_BYTES) continue;
    const { hazards, score } = scoreHazards(source);
    if (score < MIN_SCORE) continue;
    found.push({ file: relative(root, path).split(sep).join('/'), hazards, score });
  }
  return found.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
}

/**
 * The name a probe would use to reach this file: its package or directory
 * (packages/workspace-factory/src/index.ts -> workspace-factory), else its stem.
 */
export function hazardModuleKey(file: string): string {
  const parts = file.split('/');
  const stem = (parts[parts.length - 1] ?? file).replace(/\.[^.]+$/, '');
  const srcAt = parts.lastIndexOf('src');
  const owner = srcAt > 0 ? parts[srcAt - 1] : undefined;
  return owner ?? (stem === 'index' ? (parts[parts.length - 2] ?? stem) : stem);
}
