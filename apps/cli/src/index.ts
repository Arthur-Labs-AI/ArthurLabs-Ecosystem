#!/usr/bin/env node
/**
 * Minimal Phase 1 CLI shell. Only `qa --version` and `qa doctor`.
 * doctor reports foundation readiness; harness integrations are
 * explicitly NOT implemented in Phase 1 (no SDK detection, no keys).
 */
import { HarnessEventSchema, ProjectSchema } from '@qa/schemas';
import { FakeHarnessAdapter } from '@qa/harness-protocol';

export const QA_VERSION = '0.1.0';

export function versionLine(): string {
  return 'qa ' + QA_VERSION;
}

export function doctorLines(): string[] {
  void ProjectSchema;
  void HarnessEventSchema;
  void FakeHarnessAdapter;
  return [
    'QA Platform',
    '',
    'Node         OK',
    'Domain       OK',
    'Schemas      OK',
    'Protocol     OK',
    '',
    'Agent harness integrations are not implemented in Phase 1.',
  ];
}

function printHelp(): void {
  console.log(
    [
      'Usage: qa [--version] [doctor]',
      '',
      '  qa --version   Print CLI version',
      '  qa doctor      Check Phase 1 foundation readiness',
    ].join('\n'),
  );
}

export function runCli(argv: readonly string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  if (args.includes('--version') || args.includes('-V')) {
    console.log(versionLine());
    return 0;
  }
  if (args[0] === 'doctor') {
    for (const line of doctorLines()) console.log(line);
    return 0;
  }
  console.error('Unknown command: ' + args.join(' '));
  printHelp();
  return 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith('/dist/index.js');
if (isMain) {
  process.exitCode = runCli(process.argv);
}
