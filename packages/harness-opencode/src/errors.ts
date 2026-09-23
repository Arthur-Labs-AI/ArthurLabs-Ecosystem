export type OpenCodeHarnessErrorCode =
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
  | 'OPENCODE_CANCEL_FAILED';

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
