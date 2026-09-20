export type ClaudeCodeHarnessErrorCode =
  | 'GLM_STACK_UNAVAILABLE'
  | 'GLM_BINARY_NOT_FOUND'
  | 'GLM_MODEL_NOT_CONFIGURED'
  | 'GLM_START_FAILED'
  | 'GLM_AUTH_FAILED'
  | 'GLM_SANDBOX_UNAVAILABLE'
  | 'GLM_INVALID_RESULT'
  | 'GLM_SUBAGENT_FORBIDDEN'
  | 'GLM_REPORT_TOOL_FORBIDDEN'
  | 'GLM_TOOL_LOOP'
  | 'GLM_CANCEL_FAILED';

export class ClaudeCodeHarnessError extends Error {
  constructor(
    readonly code: ClaudeCodeHarnessErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ClaudeCodeHarnessError';
  }
}
