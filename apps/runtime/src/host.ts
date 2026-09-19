#!/usr/bin/env node
/** stdio entry: `sentry-runtime --stdio [--data-root <path>]`. */
import { serveStdio } from './runtime.js';

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
if (!args.stdio) {
  process.stderr.write('Usage: sentry-runtime --stdio [--data-root <path>]\n');
  process.exit(2);
}
await serveStdio(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot });
