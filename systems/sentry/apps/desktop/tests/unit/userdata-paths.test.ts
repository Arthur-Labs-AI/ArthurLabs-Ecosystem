import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Regression: our userData children once used a `preferences` directory,
// which collides with Chromium's own `Preferences` file on
// case-insensitive filesystems — every prefs save failed with EEXIST.
// Our directories must never be named `preferences`.
describe('userData path collisions', () => {
  for (const file of [
    'src/main/services/provider-credentials.ts',
    'src/main/services/wsl-runtime-client.ts',
  ]) {
    it(file + ' never uses a preferences directory', () => {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).toContain('sentry-prefs');
      expect(text).not.toContain("'preferences'");
    });
  }
});
