#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { FakeHarnessAdapter, HARNESS_PROTOCOL_VERSION } from '@qa/harness-protocol';
import {
  SentryDatabase,
  SentryRepository,
  resolveInside,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { FakeRunCoordinator, type SimulationScenario } from '@qa/run-engine';
import {
  AgentStackDefinitionSchema,
  HarnessEventSchema,
  ProjectIdSchema,
  ProjectSchema,
  QARunIdSchema,
} from '@qa/schemas';

export const QA_VERSION = '0.2.0';

export function versionLine(): string {
  return 'qa ' + QA_VERSION;
}

export interface DoctorOptions {
  readonly probeRuntime?: boolean;
  readonly dataRoot?: string;
}

export function doctorLines(options: DoctorOptions = {}): string[] {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const domainReady =
    INITIAL_AGENT_STACKS.length > 0 &&
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
  const dataRoot = options.dataRoot ?? resolveSentryDataRoot();
  let filesystemReady = true;
  let sqliteReady = true;
  if (options.probeRuntime === true) {
    try {
      mkdirSync(dataRoot, { recursive: true });
    } catch {
      filesystemReady = false;
    }
    try {
      const database = new SentryDatabase({ dataRoot });
      database.close();
    } catch {
      sqliteReady = false;
    }
  }
  const status = (ready: boolean) => (ready ? 'OK' : 'ERROR');
  return [
    'Sentry',
    '',
    'Node         ' + status(nodeMajor >= 22),
    'Data Root    ' + status(dataRoot.length > 0) + '  ' + dataRoot,
    'SQLite       ' + status(sqliteReady),
    'Filesystem   ' + status(filesystemReady),
    'Domain       ' + status(domainReady),
    'Schemas      ' + status(schemasReady),
    'Protocol     ' + status(protocolReady),
    '',
    'Real AI harnesses are not implemented yet.',
  ];
}

function printHelp(): void {
  console.log(
    [
      'Usage: qa <command>',
      '',
      '  qa --version',
      '  qa doctor',
      '  qa project add <path>',
      '  qa project list',
      '  qa project show <project-id>',
      '  qa project update <project-id> [path]',
      '  qa project delete <project-id> --yes',
      '  qa run simulate <project-id> [--scenario success|partial|all-fail|transport-loss|timeout]',
      '  qa run list <project-id>',
      '  qa run show <run-id>',
      '  qa run export <run-id> --format log|json',
    ].join('\n'),
  );
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function withRuntime<T>(
  operation: (runtime: {
    repository: SentryRepository;
    projects: ProjectManager;
    runs: FakeRunCoordinator;
    dataRoot: string;
  }) => Promise<T>,
): Promise<T> {
  const dataRoot = resolveSentryDataRoot();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const projects = new ProjectManager(dataRoot, repository);
  const runs = new FakeRunCoordinator(dataRoot, repository);
  try {
    await runs.recover();
    return await operation({ repository, projects, runs, dataRoot });
  } finally {
    database.close();
  }
}

async function projectCommand(args: readonly string[]): Promise<number> {
  const command = args[1];
  if (command === 'add' && args[2] !== undefined) {
    return withRuntime(async ({ projects }) => {
      const added = await projects.addProject(args[2] as string, {
        onProgress: (progress) => {
          if (progress.filesProcessed % 100 === 0) {
            console.log(
              'Copied ' +
                progress.filesProcessed +
                ' files (' +
                progress.bytesProcessed +
                ' bytes)',
            );
          }
        },
      });
      console.log('Added ' + added.project.id + '\nRevision: ' + added.revision.id);
      return 0;
    });
  }
  if (command === 'list') {
    return withRuntime(async ({ projects, repository }) => {
      console.log('Sentry Projects\n');
      for (const record of projects.listProjects()) {
        console.log(
          [
            record.project.id,
            record.project.name,
            'Source: ' + record.project.sourcePath,
            'Revision: ' + record.revision.id,
            'Status: ' + record.managedCopy.state,
            'Runs: ' + repository.listRuns(record.project.id).length,
            '',
          ].join('\n'),
        );
      }
      return 0;
    });
  }
  if (command === 'show' && args[2] !== undefined) {
    const projectId = ProjectIdSchema.parse(args[2]);
    return withRuntime(async ({ projects }) => {
      const record = projects.getProject(projectId);
      if (record === undefined) throw new Error('Project not found: ' + projectId);
      console.log(JSON.stringify(record, null, 2));
      return 0;
    });
  }
  if (command === 'update' && args[2] !== undefined) {
    const projectId = ProjectIdSchema.parse(args[2]);
    return withRuntime(async ({ projects }) => {
      const updated = await projects.updateProjectCopy(projectId, args[3]);
      console.log('Updated ' + projectId + '\nRevision: ' + updated.revision.id);
      return 0;
    });
  }
  if (command === 'delete' && args[2] !== undefined) {
    if (!args.includes('--yes')) {
      console.error('Project deletion requires --yes. The original source is never deleted.');
      return 1;
    }
    const projectId = ProjectIdSchema.parse(args[2]);
    return withRuntime(async ({ projects }) => {
      await projects.deleteProject(projectId);
      console.log('Deleted Sentry-managed project data for ' + projectId);
      return 0;
    });
  }
  throw new Error('Invalid project command');
}

async function runCommand(args: readonly string[]): Promise<number> {
  const command = args[1];
  if (command === 'simulate' && args[2] !== undefined) {
    const projectId = ProjectIdSchema.parse(args[2]);
    const scenario = (option(args, '--scenario') ?? 'success') as SimulationScenario;
    const instructions = option(args, '--instructions');
    const agentOption = option(args, '--agents');
    const agentStackIds = agentOption
      ?.split(',')
      .map((name) => (name.startsWith('stack_') ? name : 'stack_' + name + '_main'));
    return withRuntime(async ({ runs }) => {
      console.log('SIMULATED / FAKE HARNESS RUN');
      const details = await runs.simulate(projectId, {
        scenario,
        ...(instructions === undefined ? {} : { instructions }),
        ...(agentStackIds === undefined
          ? {}
          : {
              agentStackIds: agentStackIds.map((id) =>
                AgentStackDefinitionSchema.shape.id.parse(id),
              ),
            }),
      });
      console.log('Run: ' + details.run.id + '\nStatus: ' + details.run.status);
      return 0;
    });
  }
  if (command === 'list' && args[2] !== undefined) {
    const projectId = ProjectIdSchema.parse(args[2]);
    return withRuntime(async ({ runs }) => {
      for (const run of runs.listRuns(projectId)) {
        console.log(run.id + '  ' + run.status + '  ' + run.mode + '  ' + run.createdAt);
      }
      return 0;
    });
  }
  if (command === 'show' && args[2] !== undefined) {
    const runId = QARunIdSchema.parse(args[2]);
    return withRuntime(async ({ runs }) => {
      const details = runs.getRunDetails(runId);
      console.log(
        JSON.stringify(
          {
            ...details,
            counts: {
              findings: details.findings.length,
              evidence: details.evidence.length,
              events: details.events.length,
            },
          },
          null,
          2,
        ),
      );
      return 0;
    });
  }
  if (command === 'export' && args[2] !== undefined) {
    const runId = QARunIdSchema.parse(args[2]);
    const format = option(args, '--format');
    if (format !== 'log' && format !== 'json') throw new Error('--format must be log or json');
    return withRuntime(async ({ runs, repository, dataRoot }) => {
      const manifest = await runs.exportRun(runId, format);
      const artifact = repository.getArtifact(manifest.artifactId);
      if (artifact === undefined) throw new Error('Export artifact metadata missing');
      console.log(resolveInside(dataRoot, artifact.relativeStoragePath));
      return 0;
    });
  }
  throw new Error('Invalid run command');
}

export function runCli(argv: readonly string[]): number | Promise<number> {
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
    for (const line of doctorLines({ probeRuntime: true })) console.log(line);
    return 0;
  }
  const operation =
    args[0] === 'project' ? projectCommand(args) : args[0] === 'run' ? runCommand(args) : undefined;
  if (operation === undefined) {
    console.error('Unknown command: ' + args.join(' '));
    printHelp();
    return 1;
  }
  return operation.catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const code = 'code' in error && typeof error.code === 'string' ? error.code + ': ' : '';
    console.error(code + error.message);
    return 1;
  });
}

export function isMainModule(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(argvEntry);
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const result = runCli(process.argv);
  if (result instanceof Promise) {
    result
      .then((code) => {
        process.exitCode = code;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  } else {
    process.exitCode = result;
  }
}
