// Production CLI execution layer: a thin frontend over the running Sentry
// Desktop broker. Every command travels the named pipe to Electron main,
// which dispatches through the shared command router to the canonical WSL
// runtime. This module owns NO database, NO leases, NO harnesses, and NO
// provider secrets: it maps CLI arguments to broker commands and adapts
// broker payloads into the stable CLI machine envelope.
import { writeFile } from 'node:fs/promises';
import {
  CLI_CONTRACT_VERSION,
  CliErrorCodeSchema,
  CliErrorEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  type CliErrorEnvelope,
  type CliSuccessEnvelope,
} from '@qa/schemas';
import { CLI_IPC_PROTOCOL_VERSION } from '@qa/shared';
import type { ParsedCliCommand } from './arguments.js';
import { CliUsageError } from './arguments.js';
import { summarizeRunStartAgents } from './run-summary.js';
import {
  DesktopNotRunningError,
  DesktopProtocolError,
  SentryDesktopClient,
} from './desktop-client.js';

export interface FrontendOptions {
  readonly onDiagnostic?: (message: string) => void;
  readonly createClient?: () => SentryDesktopClient;
}

const TERMINAL_RUN = new Set(['completed', 'partial', 'failed', 'cancelled']);
const TERMINAL_RETEST = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const AGENT_NAMES = ['opencode', 'deepseek', 'glm'] as const;
const MODEL_ENV: Record<string, string> = {
  opencode: 'SENTRY_OPENCODE_MODEL',
  deepseek: 'SENTRY_DEEPSEEK_MODEL',
  glm: 'SENTRY_GLM_MODEL',
};
const HARNESS_NAME: Record<string, string> = {
  opencode: 'opencode',
  deepseek: 'deepseek-harness',
  glm: 'claude-code',
};

function success(command: CliSuccessEnvelope['command'], data: unknown): CliSuccessEnvelope {
  return CliSuccessEnvelopeSchema.parse({
    schemaVersion: CLI_CONTRACT_VERSION,
    command,
    ok: true,
    data,
  });
}

function toCliError(cause: unknown): { code: string; message: string } {
  if (cause instanceof CliUsageError) {
    return { code: 'INVALID_ARGUMENT', message: bounded(cause.message) };
  }
  if (cause instanceof DesktopNotRunningError) {
    return { code: cause.code, message: bounded(cause.message) };
  }
  if (cause instanceof DesktopProtocolError) {
    return brokerError(cause.code, cause.message);
  }
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const typed = cause as { code?: unknown; message?: unknown };
    if (typeof typed.code === 'string') {
      return brokerError(
        typed.code,
        typeof typed.message === 'string' ? typed.message : 'Sentry Desktop request failed.',
      );
    }
  }
  if (cause instanceof Error && cause.name === 'ZodError') {
    return { code: 'RUN_EXECUTION_FAILED', message: 'Sentry hit an internal validation failure.' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Sentry could not complete the command.' };
}

export function frontendErrorEnvelope(
  command: ParsedCliCommand['command'] | 'unknown',
  cause: unknown,
): CliErrorEnvelope {
  const mapped = toCliError(cause);
  const code = CliErrorCodeSchema.safeParse(mapped.code).success ? mapped.code : 'INTERNAL_ERROR';
  return CliErrorEnvelopeSchema.parse({
    schemaVersion: CLI_CONTRACT_VERSION,
    command,
    ok: false,
    error: { code, message: mapped.message, retryable: isRetryable(code) },
  });
}

function brokerError(code: string, message: string): { code: string; message: string } {
  if (CliErrorCodeSchema.safeParse(code).success) {
    return { code, message: bounded(message) };
  }
  return { code: 'INTERNAL_ERROR', message: 'Sentry Desktop request failed.' };
}

function isRetryable(code: string): boolean {
  return [
    'PROJECT_LOCKED',
    'ACTIVE_RUN_EXISTS',
    'SQLITE_BUSY',
    'RUNTIME_LEASE_CONFLICT',
    'RUNTIME_LEASE_LOST',
    'RUN_NOT_COMPLETE',
  ].includes(code);
}

function bounded(message: string): string {
  return (
    message
      .replace(/\b(Bearer)\s+\S+/gi, '$1 [REDACTED]')
      .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 1000) || 'Sentry command failed'
  );
}

function devOnly(command: string): never {
  throw new CliUsageError(
    command +
      ' is not part of the production Desktop runtime. Rerun with SENTRY_CLI_TRANSPORT=direct for development-only access.',
  );
}
interface Broker {
  request<T>(command: string, payload?: Record<string, unknown>): Promise<T>;
  readonly productVersion: string | undefined;
}

async function withBroker<T>(
  options: FrontendOptions,
  operation: (broker: Broker) => Promise<T>,
): Promise<T> {
  const client = options.createClient?.() ?? new SentryDesktopClient();
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function stackIdForAgent(name: string): string {
  return 'stack_' + name + '_main';
}

function shortAgentName(stackId: string): string {
  for (const name of AGENT_NAMES) {
    if (stackId === stackIdForAgent(name)) return name;
  }
  return stackId;
}

async function pollRunStatus(
  broker: Broker,
  runId: string,
  onDiagnostic?: (message: string) => void,
): Promise<Record<string, unknown>> {
  for (;;) {
    const status = (await broker.request('runs:status', { runId })) as Record<string, unknown>;
    const state = String((status as { status?: unknown }).status ?? '');
    if (TERMINAL_RUN.has(state)) return status;
    onDiagnostic?.('run ' + runId + ' status: ' + state);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function pollRetest(
  broker: Broker,
  retestRunId: string,
  onDiagnostic?: (message: string) => void,
): Promise<Record<string, unknown>> {
  for (;;) {
    const snapshot = (await broker.request('retests:get', { retestRunId })) as {
      retestRun: { status?: string };
    } & Record<string, unknown>;
    const state = String(snapshot.retestRun?.status ?? '');
    if (TERMINAL_RETEST.has(state)) return snapshot;
    onDiagnostic?.('retest ' + retestRunId + ' status: ' + state);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
function adaptRunListItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: row['id'],
    projectId: row['projectId'],
    mode: row['mode'],
    status: row['status'],
    createdAt: row['createdAt'],
    ...(row['startedAt'] === undefined ? {} : { startedAt: row['startedAt'] }),
    ...(row['completedAt'] === undefined ? {} : { completedAt: row['completedAt'] }),
  };
}

function adaptProjectMutation(record: Record<string, unknown>): Record<string, unknown> {
  const project = record['project'] as { id?: string } | undefined;
  const revision = record['revision'] as { id?: string } | undefined;
  const context = record['context'] as { id?: string } | undefined;
  if (typeof project?.id !== 'string' || typeof revision?.id !== 'string') {
    throw new DesktopProtocolError('DESKTOP_ERROR', 'Desktop returned an unexpected project shape');
  }
  return {
    projectId: project.id,
    revisionId: revision.id,
    ...(context?.id === undefined ? {} : { contextSnapshotId: context.id }),
  };
}

function adaptAgentList(environment: Record<string, unknown>): Record<string, unknown> {
  const stacks = (environment['agentStacks'] ?? []) as Array<Record<string, unknown>>;
  return {
    agents: stacks.map((stack) => {
      const name = shortAgentName(String(stack['id'] ?? ''));
      const binaryAvailable = stack['binaryAvailable'] === true;
      const configured = stack['configured'] === true && binaryAvailable;
      const readiness = String(stack['readiness'] ?? '');
      const valid = ['unconfigured', 'configured', 'ready', 'degraded', 'unavailable'];
      const status = !binaryAvailable
        ? 'unavailable'
        : !configured
          ? 'unconfigured'
          : valid.includes(readiness)
            ? readiness
            : 'configured';
      return {
        id: name,
        displayName: String(stack['displayName'] ?? name),
        harness: HARNESS_NAME[name] ?? name,
        available: configured,
        configured,
        binaryAvailable,
        runtimeVerified: stack['runtimeVerified'] === true,
        status,
        modelEnvironmentVariable: MODEL_ENV[name] ?? 'SENTRY_MODEL',
      };
    }),
  };
}
function adaptAgentDoctor(
  agent: string,
  environment: Record<string, unknown>,
): Record<string, unknown> {
  const stacks = (environment['agentStacks'] ?? []) as Array<Record<string, unknown>>;
  const stack = stacks.find((entry) => shortAgentName(String(entry['id'] ?? '')) === agent);
  if (stack === undefined)
    throw new DesktopProtocolError('AGENT_STACK_UNAVAILABLE', 'Unknown agent: ' + agent);
  const configured = stack['configured'] === true;
  const binaryAvailable = stack['binaryAvailable'] === true;
  const runtimeVerified = stack['runtimeVerified'] === true;
  const checks = [
    {
      name: 'model',
      status: configured ? 'pass' : 'fail',
      ...(configured ? {} : { message: 'model is not configured' }),
    },
    {
      name: 'binary',
      status: binaryAvailable ? 'pass' : 'fail',
      ...(binaryAvailable ? {} : { message: 'executable is not available' }),
    },
    {
      name: 'runtime',
      status: runtimeVerified ? 'pass' : 'warn',
      ...(runtimeVerified ? {} : { message: 'not runtime verified' }),
    },
  ];
  const failures = checks.filter((check) => check.status === 'fail').length;
  return {
    agent,
    status: failures === 0 ? 'healthy' : failures === checks.length ? 'unavailable' : 'degraded',
    checks,
    checkedAt: new Date().toISOString(),
    credentialConfigured: configured,
    configured,
    binaryAvailable,
    runtimeVerified,
  };
}

function adaptIssueListItem(
  issue: Record<string, unknown>,
  occurrenceCount: number,
): Record<string, unknown> {
  return {
    issueId: issue['id'],
    projectId: issue['projectId'],
    title: issue['title'],
    currentState: issue['currentState'],
    occurrenceCount,
    updatedAt: issue['updatedAt'],
  };
}
export async function executeFrontendCommand(
  input: ParsedCliCommand,
  options: FrontendOptions = {},
): Promise<CliSuccessEnvelope> {
  return withBroker(options, async (broker) => {
    if (input.command === 'capabilities') {
      return success(input.command, {
        cliContractVersion: CLI_CONTRACT_VERSION,
        features: {
          projectLifecycle: true,
          runInspection: true,
          fakeRunSimulation: true,
          realAgentExecution: true,
          retestExecution: true,
          runCancellation: true,
          targetedExecution: true,
          issueLineage: true,
        },
        agentStacks: [
          { id: 'opencode', displayName: 'OpenCode QA Agent', harness: 'opencode' },
          { id: 'deepseek', displayName: 'DeepSeek QA Agent', harness: 'deepseek-harness' },
          { id: 'glm', displayName: 'GLM QA Agent', harness: 'claude-code' },
        ],
        runResultExport: true,
        asyncRunStart: true,
        ipcProtocolVersion: CLI_IPC_PROTOCOL_VERSION,
        ...(broker.productVersion === undefined ? {} : { productVersion: broker.productVersion }),
        productionCommands: {
          runSimulation: false,
          realRunExecution: true,
          runResult: true,
          runExport: true,
        },
      });
    }
    if (input.command === 'agent.list') {
      const environment = (await broker.request('doctors:environment', {})) as Record<
        string,
        unknown
      >;
      return success(input.command, adaptAgentList(environment));
    }
    if (input.command === 'agent.doctor') {
      const environment = (await broker.request('doctors:environment', {})) as Record<
        string,
        unknown
      >;
      return success(input.command, adaptAgentDoctor(input.agent, environment));
    }
    if (input.command === 'project.add') {
      const record = (await broker.request('projects:add', {
        sourcePath: input.sourcePath,
      })) as Record<string, unknown>;
      return success(input.command, adaptProjectMutation(record));
    }
    if (input.command === 'project.list') {
      const projects = (await broker.request('projects:list', {})) as unknown;
      return success(input.command, { projects });
    }
    if (input.command === 'project.show') {
      return success(
        input.command,
        await broker.request('projects:get', { projectId: input.projectId }),
      );
    }
    if (input.command === 'project.update') {
      const record = (await broker.request('projects:update', {
        projectId: input.projectId,
        ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      })) as Record<string, unknown>;
      return success(input.command, adaptProjectMutation(record));
    }
    if (input.command === 'project.delete') {
      return success(
        input.command,
        await broker.request('projects:delete', { projectId: input.projectId }),
      );
    }
    if (input.command === 'project.revisions') {
      const record = (await broker.request('projects:get', { projectId: input.projectId })) as {
        revision?: { id?: string };
      } & Record<string, unknown>;
      const revisions = (await broker.request('projects:revisions', {
        projectId: input.projectId,
      })) as Array<Record<string, unknown>>;
      const runs = (await broker.request('runs:list', { projectId: input.projectId })) as Array<
        Record<string, unknown>
      >;
      const byRevision = new Map<string, string[]>();
      await Promise.all(
        runs.map(async (row) => {
          const runId = String(row['id'] ?? row['runId'] ?? '');
          if (runId.length === 0) return;
          try {
            const snapshot = (await broker.request('runs:get', { runId })) as {
              revision?: { id?: string };
            } & Record<string, unknown>;
            const revisionId = snapshot.revision?.id;
            if (typeof revisionId === 'string') {
              const list = byRevision.get(revisionId) ?? [];
              list.push(runId);
              byRevision.set(revisionId, list);
            }
          } catch {
            /* a run that vanishes mid-read simply contributes no mapping */
          }
        }),
      );
      return success(input.command, {
        projectId: input.projectId,
        currentRevisionId: record.revision?.id,
        revisions: revisions.map((revision) => ({
          revisionId: revision['id'],
          importedAt: revision['importedAt'],
          contentHash: revision['contentHash'],
          current: revision['id'] === record.revision?.id,
          runIds: byRevision.get(String(revision['id'] ?? '')) ?? [],
        })),
      });
    }
    if (input.command === 'project.doctor') {
      const report = (await broker.request('projects:doctor', {
        projectId: input.projectId,
      })) as Record<string, unknown>;
      const environment = (await broker.request('doctors:environment', {})) as {
        verifier?: {
          sandboxAvailable?: boolean;
          runtimeReplaySupported?: boolean;
          reason?: string;
        };
        agentStacks?: Array<{ id?: string; binaryAvailable?: boolean }>;
      } & Record<string, unknown>;
      const ecosystem = (report['detectedEcosystem'] ?? []) as string[];
      return success(input.command, {
        ...report,
        runtimes: [{ name: 'node', available: true }].concat(
          ecosystem.filter((name) => name !== 'node').map((name) => ({ name, available: false })),
        ),
        verifier: {
          sandboxAvailable: environment.verifier?.sandboxAvailable === true,
          runtimeReplaySupported: environment.verifier?.runtimeReplaySupported === true,
          ...(environment.verifier?.reason === undefined
            ? {}
            : { reason: environment.verifier.reason }),
        },
        warnings: ((report['warnings'] ?? []) as string[]).concat(
          ecosystem.some((name) => name !== 'node')
            ? ['Non-node runtime availability is unverified from the CLI; see Desktop Environment.']
            : [],
        ),
      });
    }
    if (input.command === 'run.start') {
      const started = (await broker.request('runs:start', {
        projectId: input.projectId,
        mode: input.mode,
        ...(input.paths === undefined
          ? {}
          : {
              includePaths: input.paths
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        agentStackIds: input.agents.map((name) => stackIdForAgent(name)),
        ...(input.runTimeoutMs === undefined ? {} : { runTimeoutMs: input.runTimeoutMs }),
      })) as { operationId?: string; runId?: string; status?: string } & Record<string, unknown>;
      if (typeof started.runId !== 'string') {
        throw new DesktopProtocolError(
          'DESKTOP_ERROR',
          'Desktop started a run without returning its id',
        );
      }
      if (input.wait !== true) {
        // automation client safety: the paid run may already be executing. Return the
        // created runId immediately with the persisted initial status from
        // the start response. No follow-up request is allowed to turn this
        // success into a failure (pipe cut, restart, timeout would otherwise
        // hide the run and invite a duplicate paid retry).
        // Older runtimes omit status; the engine always persists the row as
        // agents_running before the start response can return.
        const initialStatus =
          typeof started.status === 'string' && started.status.length > 0
            ? started.status
            : 'agents_running';
        return success(input.command, {
          simulated: false,
          runId: started.runId,
          projectId: input.projectId,
          status: initialStatus,
          ...(started.operationId === undefined ? {} : { operationId: started.operationId }),
        });
      }
      const terminal = await pollRunStatus(broker, started.runId, options.onDiagnostic);
      const snapshot = (await broker.request('runs:get', { runId: started.runId })) as {
        agentRuns?: Array<{
          agentStackId?: string;
          status?: string;
          failure?: { code?: string; message?: string; retryable?: boolean };
        }>;
        findings?: unknown[];
      } & Record<string, unknown>;
      const agentRuns = (snapshot.agentRuns ?? []).map((agent) => ({
        agentStackId: String(agent.agentStackId ?? '') as never,
        status: agent.status as never,
        ...(agent.failure === undefined ? {} : { failure: agent.failure as never }),
      }));
      return success(input.command, {
        simulated: false,
        runId: started.runId,
        projectId: input.projectId,
        status: (terminal as { status?: string }).status,
        ...(started.operationId === undefined ? {} : { operationId: started.operationId }),
        agents: summarizeRunStartAgents(agentRuns),
        findings: { total: Array.isArray(snapshot.findings) ? snapshot.findings.length : 0 },
      });
    }
    if (input.command === 'run.list') {
      const rows = (await broker.request('runs:list', { projectId: input.projectId })) as Array<
        Record<string, unknown>
      >;
      return success(input.command, { runs: rows.map((row) => adaptRunListItem(row)) });
    }
    if (input.command === 'run.show') {
      const snapshot = (await broker.request('runs:get', { runId: input.runId })) as Record<
        string,
        unknown
      >;
      return success(input.command, {
        run: snapshot['run'],
        agentRuns: snapshot['agentRuns'],
        findings: snapshot['findings'],
        evidence: snapshot['evidence'],
        exports: snapshot['exports'] ?? [],
        counts: snapshot['counts'],
      });
    }
    if (input.command === 'run.status') {
      return success(input.command, await broker.request('runs:status', { runId: input.runId }));
    }
    if (input.command === 'run.result') {
      const exported = (await broker.request('runs:export-content', {
        runId: input.runId,
        format: 'json',
      })) as { contentBase64?: string } & Record<string, unknown>;
      if (typeof exported.contentBase64 !== 'string') {
        throw new DesktopProtocolError('DESKTOP_ERROR', 'Desktop returned no export bytes');
      }
      let result: unknown;
      try {
        result = JSON.parse(Buffer.from(exported.contentBase64, 'base64').toString('utf8'));
      } catch {
        throw new DesktopProtocolError(
          'DESKTOP_ERROR',
          'Desktop returned export bytes that are not JSON',
        );
      }
      return success(input.command, { runId: input.runId, format: 'json' as const, result });
    }
    if (input.command === 'run.export') {
      if (input.out === undefined) {
        throw new CliUsageError(
          'run export writes through the Desktop broker: pass --out <path>, or use run result --json for the canonical JSON on stdout.',
        );
      }
      const exported = (await broker.request('runs:export-content', {
        runId: input.runId,
        format: input.format,
      })) as { contentBase64?: string } & Record<string, unknown>;
      if (typeof exported.contentBase64 !== 'string') {
        throw new DesktopProtocolError('DESKTOP_ERROR', 'Desktop returned no export bytes');
      }
      await writeFile(input.out, Buffer.from(exported.contentBase64, 'base64'));
      return success(input.command, { runId: input.runId, format: input.format, path: input.out });
    }
    if (input.command === 'run.cancel') {
      const outcome = (await broker.request('runs:cancel', { runId: input.runId })) as {
        runId?: string;
        status?: string;
        cancelledAgents?: number;
        ownerAcknowledged?: boolean;
      } & Record<string, unknown>;
      const status = (await broker.request('runs:status', { runId: input.runId })) as {
        findings?: { total?: number };
      } & Record<string, unknown>;
      return success(input.command, {
        runId: outcome.runId ?? input.runId,
        status: outcome.status,
        cancelledAgents: outcome.cancelledAgents ?? 0,
        ...(outcome.ownerAcknowledged === undefined
          ? {}
          : { ownerAcknowledged: outcome.ownerAcknowledged }),
        findings: { total: status.findings?.total ?? 0 },
      });
    }
    if (input.command === 'issue.list') {
      const issues = (await broker.request('issues:list', { projectId: input.projectId })) as Array<
        Record<string, unknown>
      >;
      const items = await Promise.all(
        issues.map(async (issue) => {
          const issueId = String(issue['id'] ?? '');
          try {
            const history = (await broker.request('issues:history', { issueId })) as {
              occurrences?: unknown[];
            } & Record<string, unknown>;
            return adaptIssueListItem(
              issue,
              Array.isArray(history.occurrences) ? history.occurrences.length : 0,
            );
          } catch {
            return adaptIssueListItem(issue, 0);
          }
        }),
      );
      return success(input.command, { projectId: input.projectId, issues: items });
    }
    if (input.command === 'issue.show' || input.command === 'issue.history') {
      if (!/^issue_[0-9A-HJKMNP-TV-Z]{26}$/.test(input.issueId)) {
        throw new DesktopProtocolError('ISSUE_NOT_FOUND', 'Issue not found: ' + input.issueId);
      }
      const history = (await broker.request('issues:history', {
        issueId: input.issueId,
      })) as Record<string, unknown>;
      if (input.command === 'issue.show') {
        return success(input.command, {
          issue: history['issue'],
          currentState: history['currentState'],
          occurrences: history['occurrences'],
          assessments: history['assessments'],
        });
      }
      return success(input.command, {
        issue: history['issue'],
        currentState: history['currentState'],
        events: history['events'],
        occurrences: history['occurrences'],
        assessments: history['assessments'],
      });
    }
    if (input.command === 'retest.start') {
      const started = (await broker.request('retests:start', {
        issueId: input.issueId,
        ...(input.revision === undefined ? {} : { revisionId: input.revision }),
        agentStackIds: input.agents.map((name) => stackIdForAgent(name)),
      })) as { operationId?: string; retestRunId?: string } & Record<string, unknown>;
      if (typeof started.retestRunId !== 'string') {
        throw new DesktopProtocolError(
          'DESKTOP_ERROR',
          'Desktop started a retest without returning its id',
        );
      }
      const snapshot = (await pollRetest(broker, started.retestRunId, options.onDiagnostic)) as {
        retestRun: Record<string, unknown>;
        targetRun?: { run?: { id?: string } };
        assessments?: Array<{ id?: string; result?: string }>;
      } & Record<string, unknown>;
      const assessments = Array.isArray(snapshot.assessments) ? snapshot.assessments : [];
      const assessment = assessments.length === 0 ? undefined : assessments[assessments.length - 1];
      return success(input.command, {
        retestRunId: started.retestRunId,
        issueId: input.issueId,
        status: (snapshot.retestRun as { status?: string }).status,
        ...(assessment?.id === undefined ? {} : { assessmentId: assessment.id }),
        ...(assessment?.result === undefined ? {} : { result: assessment.result }),
        ...(snapshot.targetRun?.run?.id === undefined
          ? {}
          : { targetRunId: snapshot.targetRun.run.id }),
      });
    }
    if (input.command === 'retest.show') {
      const snapshot = (await broker.request('retests:get', {
        retestRunId: input.retestRunId,
      })) as { retestRun?: unknown; assessments?: unknown[] } & Record<string, unknown>;
      const assessments = Array.isArray(snapshot.assessments) ? snapshot.assessments : [];
      return success(input.command, {
        run: snapshot.retestRun,
        ...(assessments.length === 0 ? {} : { assessment: assessments[assessments.length - 1] }),
        assessments,
      });
    }
    if (input.command === 'retest.cancel') {
      const outcome = (await broker.request('retests:cancel', {
        retestRunId: input.retestRunId,
      })) as { retestRunId?: string; status?: string } & Record<string, unknown>;
      return success(input.command, {
        retestRunId: outcome.retestRunId ?? input.retestRunId,
        status: outcome.status,
      });
    }
    devOnly(input.command);
  });
}
