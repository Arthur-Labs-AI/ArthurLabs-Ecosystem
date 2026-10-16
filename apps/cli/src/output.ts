import type {
  CliErrorEnvelope,
  CliSuccessEnvelope,
  ProjectListResult,
  RunListResult,
} from '@qa/schemas';
import { CLI_EXIT } from './exit-codes.js';

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export const consoleIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export function emitMachine(response: CliSuccessEnvelope | CliErrorEnvelope, io: CliIo): void {
  io.stdout(JSON.stringify(response));
}

export function emitHumanSuccess(response: CliSuccessEnvelope, io: CliIo): void {
  switch (response.command) {
    case 'capabilities':
      io.stdout(
        [
          'Sentry capabilities',
          '',
          'Project lifecycle: yes',
          'Run inspection: yes',
          'Fake simulation: yes (development transport only)',
          'Real agent execution: yes (OpenCode, DeepSeek, GLM)',
          'Retest execution: yes',
          'Run cancellation: yes',
          'Run result export: yes (run result)',
          'Async run start: yes (default; pass --wait to observe)',
        ].join('\n'),
      );
      return;
    case 'agent.list':
      io.stdout(
        response.data.agents
          .map((agent) => {
            const status =
              'status' in agent && typeof agent.status === 'string'
                ? agent.status
                : agent.available
                  ? 'configured'
                  : 'not configured';
            const verified =
              'runtimeVerified' in agent && agent.runtimeVerified === true
                ? ' (runtime verified)'
                : '';
            return agent.id + '  ' + agent.displayName + '  ' + status + verified;
          })
          .join('\n'),
      );
      return;
    case 'agent.doctor':
      io.stdout(
        ['Agent doctor: ' + response.data.status]
          .concat(
            response.data.checks.map(
              (check) =>
                check.status.toUpperCase() +
                '  ' +
                check.name +
                (check.message === undefined ? '' : '  ' + check.message),
            ),
          )
          .join('\n'),
      );
      return;
    case 'project.add':
      io.stdout('Added ' + response.data.projectId + '\nRevision: ' + response.data.revisionId);
      return;
    case 'project.list':
      io.stdout(
        ['Sentry Projects', '']
          .concat(
            response.data.projects.flatMap((project: ProjectListResult['projects'][number]) => [
              project.projectId,
              project.name,
              'Source: ' + project.sourcePath,
              'Revision: ' + project.currentRevisionId,
              'Status: ' + project.state,
              'Runs: ' + project.runCount,
              '',
            ]),
          )
          .join('\n'),
      );
      return;
    case 'project.show':
      io.stdout(JSON.stringify(response.data, null, 2));
      return;
    case 'project.update':
      io.stdout('Updated ' + response.data.projectId + '\nRevision: ' + response.data.revisionId);
      return;
    case 'project.delete':
      io.stdout('Deleted Sentry-managed project data for ' + response.data.projectId);
      return;
    case 'run.simulate':
      io.stdout(
        'SIMULATED / FAKE HARNESS RUN\nRun: ' +
          response.data.runId +
          '\nStatus: ' +
          response.data.status,
      );
      return;
    case 'run.start': {
      const operation =
        'operationId' in response.data && typeof response.data.operationId === 'string'
          ? '\nOperation: ' + response.data.operationId
          : '';
      io.stdout(
        'REAL QA RUN\nRun: ' +
          response.data.runId +
          '\nStatus: ' +
          response.data.status +
          operation,
      );
      return;
    }
    case 'run.result':
      io.stdout(JSON.stringify((response.data as { result?: unknown }).result ?? null, null, 2));
      return;
    case 'run.list':
      io.stdout(
        response.data.runs
          .map(
            (run: RunListResult['runs'][number]) =>
              run.runId + '  ' + run.status + '  ' + run.mode + '  ' + run.createdAt,
          )
          .join('\n'),
      );
      return;
    case 'run.show':
    case 'run.status':
      io.stdout(JSON.stringify(response.data, null, 2));
      return;
    case 'run.export':
      io.stdout(response.data.path);
      return;
    case 'verify.start': {
      const attempts = response.data.attempts as Record<string, number>;
      io.stdout(
        'VERIFICATION ' +
          response.data.status +
          '\nRun: ' +
          response.data.verificationRunId +
          '\nReproduced: ' +
          attempts['reproduced'] +
          '  Partially verified: ' +
          attempts['partiallyVerified'] +
          '  Not reproducible: ' +
          attempts['notReproducible'] +
          '  Inconclusive: ' +
          attempts['inconclusive'],
      );
      return;
    }
    case 'verify.show':
      io.stdout(JSON.stringify(response.data, null, 2));
      return;
    case 'verify.doctor': {
      const available = response.data.sandboxAvailable as boolean;
      io.stdout(
        'VERIFIER SANDBOX ' +
          (available ? 'available' : 'UNAVAILABLE') +
          '\nBackend: ' +
          response.data.sandboxBackend +
          '\nRuntime replay: ' +
          ((response.data.runtimeReplaySupported as boolean) ? 'supported' : 'inconclusive-only') +
          (response.data.reason === undefined ? '' : '\nReason: ' + response.data.reason),
      );
      return;
    }
  }
}

export function emitHumanError(response: CliErrorEnvelope, io: CliIo): void {
  io.stderr(response.error.code + ': ' + response.error.message);
}

export function successExitCode(response: CliSuccessEnvelope): number {
  if (response.command !== 'run.simulate' && response.command !== 'run.start')
    return CLI_EXIT.success;
  if (response.data.status === 'cancelled') return CLI_EXIT.cancelled;
  if (response.data.status === 'failed') return CLI_EXIT.executionFailed;
  if (response.data.status === 'partial') return CLI_EXIT.partial;
  const total =
    'findings' in response.data && response.data.findings !== undefined
      ? (response.data.findings.total ?? 0)
      : 0;
  if (total > 0) return CLI_EXIT.findings;
  return CLI_EXIT.success;
}
