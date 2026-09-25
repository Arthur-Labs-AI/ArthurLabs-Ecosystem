import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Regression: the desktop main process is ESM, where bare `require` does
// not exist. bootstrap.ts once called require('electron') directly, which
// threw ReferenceError inside the silent try/catch — misreported as
// 'safeStorage bridge unavailable' (and lost the real userData dir),
// silently disabling encrypted credential persistence. Electron must be
// reached through the module-scoped require pinned below.
describe('bootstrap electron wiring', () => {
  it('declares a module-scoped require for Electron', () => {
    const bootstrap = readFileSync(join(root, 'src', 'main', 'bootstrap.ts'), 'utf8');
    expect(bootstrap).toContain("from 'node:module'");
    expect(bootstrap).toMatch(/const require = createRequire\(import\.meta\.url\)/);
  });
});
