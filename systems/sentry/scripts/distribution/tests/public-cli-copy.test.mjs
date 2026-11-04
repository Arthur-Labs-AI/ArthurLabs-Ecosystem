import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('shipped CLI guides, visible help, UI and runtime source use generic automation wording', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const path of [
    'docs/beta/cli.md',
    'docs/setup/distribution.md',
    'apps/cli/src/production.ts',
    'apps/cli/src/index.ts',
    'scripts/launcher/commands2.ps1',
    'scripts/launcher/linux/commands/cli.sh',
    'apps/desktop/src/renderer/pages/Environment.tsx',
    'apps/runtime/src/runtime.ts',
    'packages/schemas/src/cli.schema.ts',
  ])
    assert.doesNotMatch(await readFile(join(root, path), 'utf8'), /\bNexus\b/i, path);
});
