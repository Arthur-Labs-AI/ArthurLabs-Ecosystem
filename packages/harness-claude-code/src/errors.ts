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
  | 'GLM_TOOL_PERMISSION_UNAVAILABLE'
  | 'GLM_CLAUDE_VERSION_UNVERIFIED'
  | 'GLM_CLAUDE_VERSION_UNSUPPORTED'
  | 'GLM_CLAUDE_RUNTIME_MISMATCH'
  | 'GLM_CANCEL_FAILED'
  | 'GLM_INIT_TIMEOUT'
  | 'GLM_TURN_TIMEOUT'
  | 'GLM_PROVIDER_RATE_LIMITED'
  | 'GLM_PROVIDER_TRANSIENT'
  | 'GLM_PROVIDER_BAD_REQUEST'
  | 'GLM_BINARY_START_FAILED';

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
