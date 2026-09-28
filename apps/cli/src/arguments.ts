import type { CliCommand } from '@qa/schemas';
import type { SimulationScenario } from '@qa/run-engine';
import { RUN_TIMEOUT_MS_MAX, RUN_TIMEOUT_MS_MIN } from '@qa/shared';

export class CliUsageError extends Error {
  readonly code = 'INVALID_ARGUMENT';

  constructor(
    message: string,
    readonly details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'CliUsageError';
  }
}

interface BaseCommand<C extends CliCommand> {
  readonly command: C;
}

export type AgentName = 'opencode' | 'deepseek' | 'glm';

export const AGENT_NAMES: readonly AgentName[] = ['opencode', 'deepseek', 'glm'];

export type ParsedCliCommand =
  | BaseCommand<'capabilities'>
  | BaseCommand<'agent.list'>
  | (BaseCommand<'agent.doctor'> & { readonly agent: AgentName })
  | (BaseCommand<'project.add'> & { readonly sourcePath: string })
  | BaseCommand<'project.list'>
  | (BaseCommand<'project.show'> & { readonly projectId: string })
  | (BaseCommand<'project.update'> & {
      readonly projectId: string;
      readonly sourcePath?: string;
    })
  | (BaseCommand<'project.delete'> & { readonly projectId: string })
  | (BaseCommand<'run.simulate'> & {
      readonly projectId: string;
      readonly scenario: SimulationScenario;
      readonly instructions?: string;
      readonly agents?: string;
    })
  | (BaseCommand<'run.start'> & {
      readonly projectId: string;
      readonly mode: 'full' | 'targeted';
      readonly agents: readonly AgentName[];
      readonly wait: boolean;
      readonly instructions?: string;
      readonly runTimeoutMs?: number;
      readonly paths?: string;
    })
  | (BaseCommand<'run.list'> & { readonly projectId: string })
  | (BaseCommand<'run.show'> & { readonly runId: string })
  | (BaseCommand<'run.status'> & { readonly runId: string })
  | (BaseCommand<'run.export'> & {
      readonly runId: string;
      readonly format: 'log' | 'json';
      readonly out?: string;
    })
  | (BaseCommand<'run.result'> & { readonly runId: string })
  | (BaseCommand<'run.merge'> & { readonly runId: string })
  | (BaseCommand<'run.cancel'> & { readonly runId: string })
  | (BaseCommand<'project.revisions'> & { readonly projectId: string })
  | (BaseCommand<'issue.list'> & { readonly projectId: string })
  | (BaseCommand<'issue.show'> & { readonly issueId: string })
  | (BaseCommand<'issue.history'> & { readonly issueId: string })
  | (BaseCommand<'issue.ingest'> & { readonly mergeResultId: string })
  | (BaseCommand<'retest.start'> & {
      readonly issueId: string;
      readonly revision?: string;
      readonly agents: readonly AgentName[];
    })
  | (BaseCommand<'retest.show'> & { readonly retestRunId: string })
  | (BaseCommand<'retest.cancel'> & { readonly retestRunId: string })
  | BaseCommand<'doctor.storage'>
  | (BaseCommand<'doctor.cleanup'> & { readonly apply: boolean })
  | BaseCommand<'doctor.config'>
  | (BaseCommand<'project.doctor'> & { readonly projectId: string })
  | (BaseCommand<'verify.start'> & { readonly mergeResultId: string; readonly clusters?: string })
  | (BaseCommand<'verify.show'> & { readonly verificationRunId: string })
  | BaseCommand<'verify.doctor'>;

const SIMULATION_SCENARIOS = new Set<SimulationScenario>([
  'success',
  'partial',
  'all-fail',
  'transport-loss',
  'timeout',
  'protocol-error',
]);

function fail(message: string, argument?: string): never {
  throw new CliUsageError(message, argument === undefined ? undefined : { argument });
}

function positional(args: readonly string[]): string[] {
  return args.filter((value, index) => {
    if (value.startsWith('--')) return false;
    return index === 0 || !args[index - 1]?.startsWith('--');
  });
}

function option(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) fail(name + ' may only be supplied once', name);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) fail(name + ' requires a value', name);
  return value;
}

function assertFlags(args: readonly string[], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const value of args) {
    if (value.startsWith('--') && !allowedSet.has(value)) fail('Unknown option: ' + value, value);
  }
}

function assertPositionals(args: readonly string[], count: number, usage: string): string[] {
  const values = positional(args);
  if (values.length !== count) fail('Usage: ' + usage);
  return values;
}

export function commandHint(args: readonly string[]): CliCommand | 'unknown' {
  if (args[0] === 'capabilities') return 'capabilities';
  const candidate = args[0] + '.' + (args[1] ?? '');
  const known = new Set<CliCommand>([
    'project.add',
    'project.list',
    'project.show',
    'project.update',
    'project.delete',
    'project.revisions',
    'agent.list',
    'agent.doctor',
    'run.simulate',
    'run.start',
    'run.list',
    'run.show',
    'run.status',
    'run.result',
    'run.export',
    'run.merge',
    'run.cancel',
    'issue.list',
    'issue.show',
    'issue.history',
    'issue.ingest',
    'retest.start',
    'retest.show',
    'retest.cancel',
    'doctor.storage',
    'doctor.cleanup',
    'doctor.config',
    'project.doctor',
    'verify.start',
    'verify.show',
    'verify.doctor',
  ]);
  return known.has(candidate as CliCommand) ? (candidate as CliCommand) : 'unknown';
}

export function parseCommand(args: readonly string[]): ParsedCliCommand {
  if (args[0] === 'capabilities') {
    assertFlags(args, []);
    assertPositionals(args, 1, 'qa capabilities');
    return { command: 'capabilities' };
  }

  const area = args[0];
  const action = args[1];
  const tail = args.slice(2);
  if (area === 'agent' && action === 'list') {
    assertFlags(tail, []);
    assertPositionals(tail, 0, 'qa agent list');
    return { command: 'agent.list' };
  }
  if (area === 'agent' && action === 'doctor') {
    assertFlags(tail, []);
    const [agent] = assertPositionals(tail, 1, 'qa agent doctor opencode|deepseek|glm');
    if (agent !== 'opencode' && agent !== 'deepseek' && agent !== 'glm')
      fail('Unknown agent: ' + agent + ' (expected opencode, deepseek, or glm)', agent);
    return { command: 'agent.doctor', agent };
  }
  if (area === 'project' && action === 'add') {
    assertFlags(tail, []);
    const [sourcePath] = assertPositionals(tail, 1, 'qa project add <path>');
    return { command: 'project.add', sourcePath: sourcePath as string };
  }
  if (area === 'project' && action === 'list') {
    assertFlags(tail, []);
    assertPositionals(tail, 0, 'qa project list');
    return { command: 'project.list' };
  }
  if (area === 'project' && action === 'show') {
    assertFlags(tail, []);
    const [projectId] = assertPositionals(tail, 1, 'qa project show <project-id>');
    return { command: 'project.show', projectId: projectId as string };
  }
  if (area === 'project' && action === 'update') {
    assertFlags(tail, []);
    const values = positional(tail);
    if (values.length < 1 || values.length > 2) {
      fail('Usage: qa project update <project-id> [path]');
    }
    return {
      command: 'project.update',
      projectId: values[0] as string,
      ...(values[1] === undefined ? {} : { sourcePath: values[1] }),
    };
  }
  if (area === 'project' && action === 'delete') {
    assertFlags(tail, ['--yes']);
    const values = tail.filter((value) => value !== '--yes');
    const [projectId] = assertPositionals(values, 1, 'qa project delete <project-id> --yes');
    if (!tail.includes('--yes')) fail('Project deletion requires --yes', '--yes');
    return { command: 'project.delete', projectId: projectId as string };
  }
  if (area === 'run' && action === 'simulate') {
    assertFlags(tail, ['--scenario', '--instructions', '--agents']);
    const projectId = positional(tail)[0];
    if (projectId === undefined || positional(tail).length !== 1) {
      fail('Usage: qa run simulate <project-id> [--scenario <scenario>]');
    }
    const scenario = option(tail, '--scenario') ?? 'success';
    if (!SIMULATION_SCENARIOS.has(scenario as SimulationScenario)) {
      fail('Unsupported simulation scenario: ' + scenario, '--scenario');
    }
    const instructions = option(tail, '--instructions');
    const agents = option(tail, '--agents');
    if (agents !== undefined && agents.split(',').every((value) => value.length === 0)) {
      fail('--agents requires at least one agent stack', '--agents');
    }
    return {
      command: 'run.simulate',
      projectId,
      scenario: scenario as SimulationScenario,
      ...(instructions === undefined ? {} : { instructions }),
      ...(agents === undefined ? {} : { agents }),
    };
  }
  if (area === 'run' && action === 'start') {
    assertFlags(tail, [
      '--mode',
      '--agents',
      '--wait',
      '--no-wait',
      '--instructions',
      '--timeout-ms',
      '--paths',
    ]);
    const [projectId] = positional(tail);
    if (projectId === undefined || positional(tail).length !== 1) {
      fail(
        'Usage: qa run start <project-id> --mode full|targeted [--agents opencode,deepseek,glm] --wait [--paths a,b] [--instructions text]',
      );
    }
    const mode = option(tail, '--mode');
    const agentsText = option(tail, '--agents');
    if (mode !== 'full' && mode !== 'targeted') fail('--mode must be full or targeted', '--mode');
    // Omitted --agents selects all stable real AgentStacks.
    const agents: AgentName[] =
      agentsText === undefined
        ? [...AGENT_NAMES]
        : (agentsText
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0) as AgentName[]);
    if (agents.length === 0) fail('--agents requires at least one agent stack', '--agents');
    for (const name of agents) {
      if (name !== 'opencode' && name !== 'deepseek' && name !== 'glm')
        fail('Unknown agent: ' + name + ' (expected opencode, deepseek, or glm)', '--agents');
    }
    if (new Set(agents).size !== agents.length)
      fail('--agents lists a duplicate agent', '--agents');
    // Async start is the default machine flow: the runtime owns the run and
    // the CLI exits. --wait observes the canonical run until it terminalizes.
    if (tail.includes('--wait') && tail.includes('--no-wait'))
      fail('--wait and --no-wait are mutually exclusive', '--wait');
    const wait = tail.includes('--wait');
    const instructions = option(tail, '--instructions');
    const timeoutText = option(tail, '--timeout-ms');
    const runTimeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
    if (
      runTimeoutMs !== undefined &&
      (!Number.isSafeInteger(runTimeoutMs) ||
        runTimeoutMs < RUN_TIMEOUT_MS_MIN ||
        runTimeoutMs > RUN_TIMEOUT_MS_MAX)
    ) {
      fail(
        '--timeout-ms must be an integer between ' +
          RUN_TIMEOUT_MS_MIN +
          ' and ' +
          RUN_TIMEOUT_MS_MAX,
        '--timeout-ms',
      );
    }
    const paths = option(tail, '--paths');
    if (mode === 'targeted' && (paths === undefined || paths.trim().length === 0)) {
      fail('Targeted QA requires --paths <comma-separated project-relative paths>', '--paths');
    }
    if (mode === 'full' && paths !== undefined) {
      fail('Full QA takes no --paths; use --mode targeted', '--paths');
    }
    return {
      command: 'run.start',
      projectId,
      mode: mode as 'full' | 'targeted',
      agents,
      wait,
      ...(instructions === undefined ? {} : { instructions }),
      ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
      ...(paths === undefined ? {} : { paths }),
    };
  }
  if (area === 'run' && action === 'list') {
    assertFlags(tail, []);
    const [projectId] = assertPositionals(tail, 1, 'qa run list <project-id>');
    return { command: 'run.list', projectId: projectId as string };
  }
  if (area === 'run' && (action === 'show' || action === 'status')) {
    assertFlags(tail, []);
    const [runId] = assertPositionals(tail, 1, 'qa run ' + action + ' <run-id>');
    return { command: action === 'show' ? 'run.show' : 'run.status', runId: runId as string };
  }
  if (area === 'run' && action === 'merge') {
    assertFlags(tail, []);
    const [runId] = assertPositionals(tail, 1, 'qa run merge <run-id>');
    return { command: 'run.merge', runId: runId as string };
  }
  if (area === 'run' && action === 'cancel') {
    assertFlags(tail, []);
    const [runId] = assertPositionals(tail, 1, 'qa run cancel <run-id>');
    return { command: 'run.cancel', runId: runId as string };
  }
  if (area === 'project' && action === 'revisions') {
    assertFlags(tail, []);
    const [projectId] = assertPositionals(tail, 1, 'qa project revisions <project-id>');
    return { command: 'project.revisions', projectId: projectId as string };
  }
  if (area === 'issue' && action === 'list') {
    assertFlags(tail, []);
    const [projectId] = assertPositionals(tail, 1, 'qa issue list <project-id>');
    return { command: 'issue.list', projectId: projectId as string };
  }
  if (area === 'issue' && (action === 'show' || action === 'history')) {
    assertFlags(tail, []);
    const [issueId] = assertPositionals(tail, 1, 'qa issue ' + action + ' <issue-id>');
    return {
      command: action === 'show' ? 'issue.show' : 'issue.history',
      issueId: issueId as string,
    };
  }
  if (area === 'issue' && action === 'ingest') {
    assertFlags(tail, []);
    const [mergeResultId] = assertPositionals(tail, 1, 'qa issue ingest <merge-result-id>');
    return { command: 'issue.ingest', mergeResultId: mergeResultId as string };
  }
  if (area === 'retest' && action === 'start') {
    assertFlags(tail, ['--revision', '--agents', '--wait']);
    const [issueId] = positional(tail);
    if (issueId === undefined || positional(tail).length !== 1) {
      fail(
        'Usage: qa retest start <issue-id> [--revision <revision-id>] [--agents opencode,deepseek,glm] --wait',
      );
    }
    const revision = option(tail, '--revision');
    const agentsText = option(tail, '--agents');
    const agents: AgentName[] =
      agentsText === undefined
        ? [...AGENT_NAMES]
        : (agentsText
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0) as AgentName[]);
    if (agents.length === 0) fail('--agents requires at least one agent stack', '--agents');
    for (const name of agents) {
      if (name !== 'opencode' && name !== 'deepseek' && name !== 'glm')
        fail('Unknown agent: ' + name + ' (expected opencode, deepseek, or glm)', '--agents');
    }
    if (new Set(agents).size !== agents.length)
      fail('--agents lists a duplicate agent', '--agents');
    if (!tail.includes('--wait')) fail('Retest runs require --wait', '--wait');
    return {
      command: 'retest.start',
      issueId,
      ...(revision === undefined ? {} : { revision }),
      agents,
    };
  }
  if (area === 'retest' && (action === 'show' || action === 'cancel')) {
    assertFlags(tail, []);
    const [retestRunId] = assertPositionals(tail, 1, 'qa retest ' + action + ' <retest-run-id>');
    return {
      command: action === 'show' ? 'retest.show' : 'retest.cancel',
      retestRunId: retestRunId as string,
    };
  }
  if (area === 'run' && action === 'export') {
    assertFlags(tail, ['--format', '--out']);
    const [runId] = positional(tail);
    if (runId === undefined || positional(tail).length !== 1) {
      fail('Usage: qa run export <run-id> --format log|json [--out <path>]');
    }
    const format = option(tail, '--format');
    if (format !== 'log' && format !== 'json') fail('--format must be log or json', '--format');
    const out = option(tail, '--out');
    return { command: 'run.export', runId, format, ...(out === undefined ? {} : { out }) };
  }
  if (area === 'run' && action === 'result') {
    assertFlags(tail, []);
    const [runId] = assertPositionals(tail, 1, 'qa run result <run-id>');
    return { command: 'run.result', runId: runId as string };
  }
  if (area === 'verify' && action === 'start') {
    assertFlags(tail, ['--clusters', '--wait', '--json']);
    const [mergeResultId] = positional(tail);
    if (mergeResultId === undefined || positional(tail).length !== 1) {
      fail('Usage: qa verify start <merge-result-id> [--clusters a,b]');
    }
    const clusters = option(tail, '--clusters');
    return {
      command: 'verify.start',
      mergeResultId,
      ...(clusters === undefined ? {} : { clusters }),
    };
  }
  if (area === 'verify' && action === 'show') {
    assertFlags(tail, ['--json']);
    const [verificationRunId] = assertPositionals(tail, 1, 'qa verify show <verification-run-id>');
    return { command: 'verify.show', verificationRunId: verificationRunId as string };
  }
  if (area === 'verify' && action === 'doctor') {
    assertFlags(tail, ['--json']);
    assertPositionals(tail, 0, 'qa verify doctor');
    return { command: 'verify.doctor' };
  }
  if (area === 'doctor' && action === 'storage') {
    assertFlags(tail, ['--json']);
    assertPositionals(tail, 0, 'qa doctor storage');
    return { command: 'doctor.storage' };
  }
  if (area === 'doctor' && action === 'cleanup') {
    assertFlags(tail, ['--json', '--apply']);
    assertPositionals(tail, 0, 'qa doctor cleanup [--apply]');
    return { command: 'doctor.cleanup', apply: tail.includes('--apply') };
  }
  if (area === 'doctor' && action === 'config') {
    assertFlags(tail, ['--json']);
    assertPositionals(tail, 0, 'qa doctor config');
    return { command: 'doctor.config' };
  }
  if (area === 'project' && action === 'doctor') {
    assertFlags(tail, ['--json']);
    const [projectId] = assertPositionals(tail, 1, 'qa project doctor <project-id>');
    return { command: 'project.doctor', projectId: projectId as string };
  }
  fail('Unknown command: ' + args.join(' '));
}
