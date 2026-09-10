#!/usr/bin/env node
/**
 * Minimal Phase 1 CLI shell. Only `qa --version` and `qa doctor`.
 * doctor reports foundation readiness; harness integrations are
 * explicitly NOT implemented in Phase 1 (no SDK detection, no keys).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { FakeHarnessAdapter, HARNESS_PROTOCOL_VERSION } from '@qa/harness-protocol';
import { AgentStackDefinitionSchema, HarnessEventSchema, ProjectSchema } from '@qa/schemas';

export const QA_VERSION = '0.1.0';

export function versionLine(): string {
  return 'qa ' + QA_VERSION;
}

export function doctorLines(): string[] {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const domainReady =
    INITIAL_AGENT_STACKS.length === 3 &&
    INITIAL_AGENT_STACKS.every((stack) => AgentStackDefinitionSchema.safeParse(stack).success);
  const schemasReady = ProjectSchema.safeParse({
    schemaVersion: 1,
    id: 'proj_01K7777777777777777777A8W1',
    name: 'Doctor probe',
    sourcePath: 'C:/doctor-probe',
    createdAt: '2026-09-09T19:00:00.000Z',
    updatedAt: '2026-09-09T19:00:00.000Z',
  }).success;
  const protocolReady =
    HARNESS_PROTOCOL_VERSION === 1 &&
    typeof FakeHarnessAdapter === 'function' &&
    HarnessEventSchema.safeParse({
      schemaVersion: 1,
      eventId: 'evt_01K7777777777777777777A8WX',
      agentRunId: 'arun_01K7777777777777777777A8W4',
      timestamp: '2026-09-09T19:00:00.000Z',
      type: 'run.started',
    }).success;
  const status = (ready: boolean) => (ready ? 'OK' : 'ERROR');
  return [
    'Sentry',
    '',
    'Node         ' + status(nodeMajor >= 22),
    'Domain       ' + status(domainReady),
    'Schemas      ' + status(schemasReady),
    'Protocol     ' + status(protocolReady),
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

export function isMainModule(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(argvEntry);
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  process.exitCode = runCli(process.argv);
}
