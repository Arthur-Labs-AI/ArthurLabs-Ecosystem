import { RuntimePersistenceError } from '@qa/persistence';
import { ProjectManagerError } from '@qa/project-manager';
import { RunEngineError } from '@qa/run-engine';
import { HarnessProtocolError } from '@qa/harness-protocol';
import {
  CLI_CONTRACT_VERSION,
  CliErrorEnvelopeSchema,
  type CliCommand,
  type CliError,
  type CliErrorCode,
  type CliErrorEnvelope,
} from '@qa/schemas';
import { CliUsageError } from './arguments.js';

export const CLI_EXIT = {
  success: 0,
  internal: 1,
  invalidArgument: 2,
  notFound: 3,
  conflict: 4,
  findings: 5,
  executionFailed: 6,
  partial: 7,
  cancelled: 8,
} as const;

const RETRYABLE = new Set<CliErrorCode>([
  'PROJECT_LOCKED',
  'ACTIVE_RUN_EXISTS',
  'SQLITE_BUSY',
  'RUNTIME_LEASE_CONFLICT',
  'RUNTIME_LEASE_LOST',
  'RUN_NOT_COMPLETE',
]);

function bounded(message: string): string {
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000) || 'Sentry command failed';
}

function canonicalError(cause: unknown): CliError {
  if (cause instanceof CliUsageError) {
    return {
      code: 'INVALID_ARGUMENT',
      message: bounded(cause.message),
      retryable: false,
      ...(cause.details === undefined ? {} : { details: cause.details }),
    };
  }
  if (cause instanceof ProjectManagerError) {
    const supported = new Set<CliErrorCode>([
      'PROJECT_NOT_FOUND',
      'PROJECT_SOURCE_NOT_FOUND',
      'PROJECT_SOURCE_UNREADABLE',
      'PROJECT_PATH_OVERLAP',
      'PROJECT_COPY_FAILED',
      'PROJECT_UPDATE_FAILED',
      'PROJECT_DELETE_FAILED',
      'PROJECT_LOCKED',
      'ACTIVE_RUN_EXISTS',
      'PROJECT_COPY_DRIFT',
      'INSUFFICIENT_STORAGE',
    ]);
    const code = supported.has(cause.code as CliErrorCode)
      ? (cause.code as CliErrorCode)
      : 'INTERNAL_ERROR';
    return {
      code,
      message:
        code === 'INTERNAL_ERROR'
          ? 'Sentry could not complete the project command.'
          : bounded(cause.message),
      retryable: RETRYABLE.has(code),
    };
  }
  if (cause instanceof RunEngineError) {
    const code: CliErrorCode =
      cause.code === 'RUN_NOT_FOUND'
        ? 'RUN_NOT_FOUND'
        : cause.code === 'RUN_NOT_COMPLETE'
          ? 'RUN_NOT_COMPLETE'
          : cause.code === 'PROJECT_NOT_FOUND'
            ? 'PROJECT_NOT_FOUND'
            : cause.code === 'AGENT_STACK_NOT_FOUND'
              ? 'INVALID_ARGUMENT'
              : 'RUN_EXECUTION_FAILED';
    return { code, message: bounded(cause.message), retryable: RETRYABLE.has(code) };
  }
  if (cause instanceof HarnessProtocolError) {
    return {
      code: 'HARNESS_PROTOCOL_VIOLATION',
      message: 'The agent harness emitted invalid protocol data.',
      retryable: false,
    };
  }
  if (cause instanceof RuntimePersistenceError) {
    const code: CliErrorCode =
      cause.code === 'SQLITE_BUSY'
        ? 'SQLITE_BUSY'
        : cause.code === 'RUNTIME_LEASE_CONFLICT'
          ? 'RUNTIME_LEASE_CONFLICT'
          : cause.code === 'RUNTIME_LEASE_LOST'
            ? 'RUNTIME_LEASE_LOST'
            : 'INTERNAL_ERROR';
    return {
      code,
      message: code === 'INTERNAL_ERROR' ? 'Sentry persistence failed.' : bounded(cause.message),
      retryable: RETRYABLE.has(code),
    };
  }
  if (cause instanceof Error && cause.name === 'ZodError') {
    return {
      code: 'INVALID_ARGUMENT',
      message: 'One or more arguments are invalid.',
      retryable: false,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Sentry could not complete the command.',
    retryable: false,
  };
}

export function errorEnvelope(command: CliCommand | 'unknown', cause: unknown): CliErrorEnvelope {
  return CliErrorEnvelopeSchema.parse({
    schemaVersion: CLI_CONTRACT_VERSION,
    command,
    ok: false,
    error: canonicalError(cause),
  });
}

export function errorExitCode(error: CliError): number {
  if (error.code === 'INVALID_ARGUMENT') return CLI_EXIT.invalidArgument;
  if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'RUN_NOT_FOUND')
    return CLI_EXIT.notFound;
  if (error.code === 'PROJECT_SOURCE_NOT_FOUND') return CLI_EXIT.notFound;
  if (RETRYABLE.has(error.code) || error.code === 'PROJECT_COPY_DRIFT') return CLI_EXIT.conflict;
  if (error.code === 'RUN_EXECUTION_FAILED' || error.code === 'HARNESS_PROTOCOL_VIOLATION') {
    return CLI_EXIT.executionFailed;
  }
  return CLI_EXIT.internal;
}
