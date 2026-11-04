/* global console */
// Post-build: make the sandboxed preload unambiguously CommonJS.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'preload');
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('preload: wrote dist/preload/package.json {"type": "commonjs"}');
