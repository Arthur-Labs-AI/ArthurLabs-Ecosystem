import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolchainPackId } from '@qa/shared';

/** What a project says about the toolchain version it needs, per pack ("8.0", "3.11", "stable", "17"). */
export type ToolchainHints = Partial<Record<ToolchainPackId, string>>;

export interface PinFile {
  readonly name: string;
  readonly text: string;
}

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'bin',
  'obj',
  'target',
  'dist',
  '.sentry-cache',
  '.qa-tmp',
]);
const MAX_DEPTH = 3;
const MAX_FILES_READ = 40;
const MAX_FILE_CHARS = 64_000;

const PIN_FILE =
  /^(?:global\.json|.+\.(?:cs|fs|vb)proj|\.python-version|go\.mod|rust-toolchain(?:\.toml)?|\.java-version|pom\.xml)$/i;

/** Finds the small manifest files that pin a toolchain; never reads source code. */
export async function readPinFiles(workspace: string): Promise<PinFile[]> {
  const found: PinFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES_READ) return;
      if (entry.isFile() && PIN_FILE.test(entry.name)) {
        try {
          found.push({
            name: entry.name,
            text: (await readFile(join(dir, entry.name), 'utf8')).slice(0, MAX_FILE_CHARS),
          });
        } catch {
          /* unreadable file: no hint */
        }
      } else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  await walk(workspace, 0);
  return found;
}

function newest(versions: readonly string[]): string | undefined {
  return [...versions].sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))[0];
}

/** Pure: derive version hints from manifest files. */
export function toolchainHints(files: readonly PinFile[]): ToolchainHints {
  const hints: ToolchainHints = {};
  const named = (pattern: RegExp): PinFile[] => files.filter((file) => pattern.test(file.name));

  // .NET: global.json wins; otherwise the highest modern target framework (net8.0 -> 8.0).
  const globalJson = named(/^global\.json$/i)[0]?.text.match(/"version"\s*:\s*"(\d+)\.(\d+)/);
  if (globalJson !== null && globalJson !== undefined)
    hints.dotnet = `${globalJson[1]}.${globalJson[2]}`;
  else {
    const targets: string[] = [];
    for (const file of named(/\.(?:cs|fs|vb)proj$/i)) {
      for (const element of file.text.matchAll(/<TargetFrameworks?>([^<]*)</gi)) {
        for (const tfm of (element[1] ?? '').matchAll(/\bnet(\d+)\.(\d+)\b/g))
          targets.push(`${tfm[1]}.${tfm[2]}`);
      }
    }
    const top = newest(targets);
    if (top !== undefined) hints.dotnet = top;
  }

  const python = named(/^\.python-version$/i)[0]?.text.match(/^\s*(\d+\.\d+)/);
  if (python !== null && python !== undefined) hints.python = python[1] as string;

  const go = named(/^go\.mod$/i)[0]?.text.match(/^go\s+(\d+\.\d+)/m);
  if (go !== null && go !== undefined) hints.go = go[1] as string;

  const rust = named(/^rust-toolchain(?:\.toml)?$/i)[0]?.text.match(
    /(?:channel\s*=\s*)?["']?\s*(stable|beta|nightly)/i,
  );
  if (rust !== null && rust !== undefined) hints.rust = (rust[1] as string).toLowerCase();

  const javaFile = named(/^\.java-version$/i)[0]?.text.match(/^\s*(?:1\.)?(\d+)/);
  if (javaFile !== null && javaFile !== undefined) hints.java = javaFile[1] as string;
  else {
    const pom = named(/^pom\.xml$/i)[0]?.text.match(
      /<(?:java\.version|maven\.compiler\.(?:release|source|target)|release)>\s*(?:1\.)?(\d+)\s*</,
    );
    if (pom !== null && pom !== undefined) hints.java = pom[1] as string;
  }
  return hints;
}

/** The hinted version when installed, otherwise the first (newest) installed one. */
export function chooseVersion(
  installed: readonly string[],
  hint: string | undefined,
): string | undefined {
  if (hint !== undefined && installed.includes(hint)) return hint;
  return installed[0];
}

export async function projectToolchainHints(workspace: string): Promise<ToolchainHints> {
  return toolchainHints(await readPinFiles(workspace));
}
