import type { CliCommand } from '@qa/schemas';
import type { SimulationScenario } from '@qa/run-engine';

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

export type ParsedCliCommand =
  | BaseCommand<'capabilities'>
  | BaseCommand<'agent.list'>
  | (BaseCommand<'agent.doctor'> & { readonly agent: 'muse' })
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
      readonly mode: 'full';
      readonly agents: 'muse';
      readonly wait: true;
      readonly instructions?: string;
      readonly runTimeoutMs?: number;
    })
  | (BaseCommand<'run.list'> & { readonly projectId: string })
  | (BaseCommand<'run.show'> & { readonly runId: string })
  | (BaseCommand<'run.status'> & { readonly runId: string })
  | (BaseCommand<'run.export'> & { readonly runId: string; readonly format: 'log' | 'json' });

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
    'agent.list',
    'agent.doctor',
    'run.simulate',
    'run.start',
    'run.list',
    'run.show',
    'run.status',
    'run.export',
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
    const [agent] = assertPositionals(tail, 1, 'qa agent doctor muse');
    if (agent !== 'muse') fail('Only the Muse agent is available in Phase 3');
    return { command: 'agent.doctor', agent: 'muse' };
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
    assertFlags(tail, ['--mode', '--agents', '--wait', '--instructions', '--timeout-ms']);
    const [projectId] = positional(tail);
    if (projectId === undefined || positional(tail).length !== 1) {
      fail('Usage: qa run start <project-id> --mode full --agents muse --wait');
    }
    const mode = option(tail, '--mode');
    const agents = option(tail, '--agents');
    if (mode !== 'full') fail('--mode must be full', '--mode');
    if (agents !== 'muse') fail('--agents must be muse', '--agents');
    if (!tail.includes('--wait')) fail('Phase 3 real runs require --wait', '--wait');
    const instructions = option(tail, '--instructions');
    const timeoutText = option(tail, '--timeout-ms');
    const runTimeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
    if (
      runTimeoutMs !== undefined &&
      (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs < 1_000)
    ) {
      fail('--timeout-ms must be an integer of at least 1000', '--timeout-ms');
    }
    return {
      command: 'run.start',
      projectId,
      mode: 'full',
      agents: 'muse',
      wait: true,
      ...(instructions === undefined ? {} : { instructions }),
      ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
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
  if (area === 'run' && action === 'export') {
    assertFlags(tail, ['--format']);
    const [runId] = positional(tail);
    if (runId === undefined || positional(tail).length !== 1) {
      fail('Usage: qa run export <run-id> --format log|json');
    }
    const format = option(tail, '--format');
    if (format !== 'log' && format !== 'json') fail('--format must be log or json', '--format');
    return { command: 'run.export', runId, format };
  }
  fail('Unknown command: ' + args.join(' '));
}
