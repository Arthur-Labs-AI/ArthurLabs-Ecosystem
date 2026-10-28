export type OpenCodeHarnessErrorCode =
  | 'QA_REPORT_DEADLINE'
  | 'OPENCODE_STACK_UNAVAILABLE'
  | 'OPENCODE_BINARY_NOT_FOUND'
  | 'OPENCODE_MODEL_NOT_CONFIGURED'
  | 'OPENCODE_CREDENTIAL_MISSING'
  | 'OPENCODE_START_FAILED'
  | 'OPENCODE_AUTH_FAILED'
  | 'OPENCODE_SANDBOX_UNAVAILABLE'
  | 'OPENCODE_INVALID_RESULT'
  | 'OPENCODE_SUBAGENT_FORBIDDEN'
  | 'OPENCODE_REPORT_TOOL_FORBIDDEN'
  | 'OPENCODE_CANCEL_FAILED'
  | 'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED'
  | 'OPENCODE_SESSION_MISMATCH'
  | 'OPENCODE_PROTOCOL_INVALID'
  | 'OPENCODE_VERSION_MISMATCH'
  | 'OPENCODE_UPSTREAM_FAILED';

export class OpenCodeHarnessError extends Error {
  constructor(
    readonly code: OpenCodeHarnessErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'OpenCodeHarnessError';
  }
}
