import type { CliError, CliErrorCode } from '@qa/schemas';

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

export const RETRYABLE = new Set<CliErrorCode>([
  'PROJECT_LOCKED',
  'ACTIVE_RUN_EXISTS',
  'SQLITE_BUSY',
  'RUNTIME_LEASE_CONFLICT',
  'RUNTIME_LEASE_LOST',
  'RUN_NOT_COMPLETE',
]);

export function errorExitCode(error: CliError): number {
  if (error.code === 'INVALID_ARGUMENT' || error.code === 'CLI_COMMAND_FORBIDDEN')
    return CLI_EXIT.invalidArgument;
  if (error.code === 'SENTRY_DESKTOP_NOT_RUNNING') return CLI_EXIT.internal;
  if (
    error.code === 'RUN_MAY_HAVE_STARTED' ||
    error.code === 'RESPONSE_TOO_LARGE' ||
    error.code === 'EXPORT_TOO_LARGE'
  )
    return CLI_EXIT.conflict;
  if (error.code === 'RUNTIME_MESSAGE_TOO_LARGE') return CLI_EXIT.internal;
  if (error.code === 'PROTOCOL_VERSION_MISMATCH') return CLI_EXIT.internal;
  if (error.code === 'PROVIDER_NOT_READY') return CLI_EXIT.executionFailed;
  if (
    error.code === 'PROJECT_NOT_FOUND' ||
    error.code === 'RUN_NOT_FOUND' ||
    error.code === 'ISSUE_NOT_FOUND'
  )
    return CLI_EXIT.notFound;
  if (error.code === 'PROJECT_SOURCE_NOT_FOUND') return CLI_EXIT.notFound;
  if (RETRYABLE.has(error.code) || error.code === 'PROJECT_COPY_DRIFT') return CLI_EXIT.conflict;
  if (
    error.code === 'RUN_EXECUTION_FAILED' ||
    error.code === 'HARNESS_PROTOCOL_VIOLATION' ||
    error.code.startsWith('OPENCODE_') ||
    error.code === 'AGENT_STACK_UNAVAILABLE'
  ) {
    return CLI_EXIT.executionFailed;
  }
  return CLI_EXIT.internal;
}
