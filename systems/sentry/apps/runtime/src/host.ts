#!/usr/bin/env node
/** stdio entry: `sentry-runtime --stdio [--data-root <path>]`. */
import { serveStdio } from './runtime.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv: readonly string[]): { stdio: boolean; dataRoot?: string } {
  let stdio = false;
  let dataRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stdio') stdio = true;
    else if (arg === '--data-root') {
      dataRoot = argv[index + 1];
      index += 1;
    }
  }
  return { stdio, ...(dataRoot === undefined ? {} : { dataRoot }) };
}

const args = parseArgs(process.argv.slice(2));
if (
  existsSync(join(homedir(), '.local/share/sentry/runtime/.release-maintenance')) &&
  !process.argv.includes('--release-validation')
) {
  process.stderr.write(
    'RUNTIME_MAINTENANCE: release setup is in progress; wait before opening Sentry.\n',
  );
  process.exit(3);
}
if (process.argv.includes('--release-validation') && args.dataRoot === undefined) {
  process.stderr.write('Release validation requires a disposable --data-root.\n');
  process.exit(3);
}
if (!args.stdio) {
  process.stderr.write('Usage: sentry-runtime --stdio [--data-root <path>]\n');
  process.exit(2);
}
await serveStdio(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot });
