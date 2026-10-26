import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const seedDir = dirname(fileURLToPath(import.meta.url));

/** Seed files committed to the repository (critical path + peripherals). */
export const FIXTURE_F_SEED_RELATIVE_PATHS = [
  'README.md',
  'src/api/checkout.ts',
  'src/api/router.ts',
  'src/auth/policy.ts',
  'src/service/checkout.ts',
  'src/service/pricing.ts',
  'src/billing/charge.ts',
  'src/db/orders.ts',
  'cli/receipt.ts',
  'scripts/seed-dev-data.mjs',
  'generated/api-docs.md',
] as const;

/** Critical workflow paths an efficient investigation should prioritize. */
export const FIXTURE_F_CRITICAL_PATHS = [
  'src/api/checkout.ts',
  'src/service/checkout.ts',
  'src/auth/policy.ts',
  'src/billing/charge.ts',
  'src/db/orders.ts',
] as const;

/** Peripheral prefixes that must not consume the investigation budget. */
export const FIXTURE_F_PERIPHERAL_PREFIXES = [
  'scripts/',
  'generated/',
  'peripheral/',
] as const;

async function seedFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const full = join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        if (entry === 'node_modules') continue;
        await walk(full);
        continue;
      }
      if (full.endsWith('generator.ts')) continue;
      out.push(relative(seedDir, full).split('\\').join('/'));
    }
  }
  await walk(seedDir);
  return out.sort();
}

/**
 * Materialize an isolated large-project evaluation workspace under
 * `targetDir` (created if missing). Copies the committed seed, then adds
 * `peripheralModules` deterministic filler modules under `peripheral/`.
 * Never touches the owner's real projects: all writes stay under
 * `targetDir`. Content is fixed (no randomness, no timestamps) so the
 * output is reproducible.
 */
export async function generateLargeWorkspace(
  targetDir: string,
  options?: { readonly peripheralModules?: number },
): Promise<{ readonly seedFiles: string[]; readonly peripheralFiles: string[] }> {
  const peripheralModules = options?.peripheralModules ?? 40;
  const seeds = await seedFiles();
  await mkdir(targetDir, { recursive: true });
  for (const rel of seeds) {
    const dest = join(targetDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(seedDir, rel), dest);
  }
  const peripheralFiles: string[] = [];
  for (let index = 0; index < peripheralModules; index += 1) {
    const padded = String(index).padStart(3, '0');
    const rel = 'peripheral/module-' + padded + '.ts';
    const dest = join(targetDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(
      dest,
      '// Generated peripheral module ' +
        padded +
        ' of ' +
        String(peripheralModules).padStart(3, '0') +
        '. Low-risk fixture filler; not part of the checkout workflow.\n' +
        'export const peripheralModule' +
        padded +
        ' = ' +
        String(index) +
        ';\n',
      'utf8',
    );
    peripheralFiles.push(rel);
  }
  return { seedFiles: seeds, peripheralFiles };
}
