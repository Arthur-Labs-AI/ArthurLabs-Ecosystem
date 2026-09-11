import type {
  CliErrorEnvelope,
  CliSuccessEnvelope,
  ProjectListResult,
  RunListResult,
} from '@qa/schemas';
import { CLI_EXIT } from './errors.js';

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
          'Fake simulation: yes',
          'Real agent execution: no',
          'Retest execution: no',
          'Run cancellation: no',
        ].join('\n'),
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
  }
}

export function emitHumanError(response: CliErrorEnvelope, io: CliIo): void {
  io.stderr(response.error.code + ': ' + response.error.message);
}

export function successExitCode(response: CliSuccessEnvelope): number {
  if (response.command !== 'run.simulate') return CLI_EXIT.success;
  if (response.data.status === 'cancelled') return CLI_EXIT.cancelled;
  if (response.data.status === 'failed') return CLI_EXIT.executionFailed;
  if (response.data.status === 'partial') return CLI_EXIT.partial;
  if (response.data.findings.total > 0) return CLI_EXIT.findings;
  return CLI_EXIT.success;
}
