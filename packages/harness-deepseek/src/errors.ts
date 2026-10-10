export type DeepSeekHarnessErrorCode =
  | 'DEEPSEEK_STACK_UNAVAILABLE'
  | 'DEEPSEEK_BINARY_NOT_FOUND'
  | 'DEEPSEEK_MODEL_NOT_CONFIGURED'
  | 'DEEPSEEK_START_FAILED'
  | 'DEEPSEEK_AUTH_FAILED'
  | 'DEEPSEEK_PROVIDER_FAILED'
  | 'DEEPSEEK_SANDBOX_UNAVAILABLE'
  | 'DEEPSEEK_INVALID_RESULT'
  | 'DEEPSEEK_SUBAGENT_FORBIDDEN'
  | 'DEEPSEEK_REPORT_TOOL_FORBIDDEN'
  | 'DEEPSEEK_CANCEL_FAILED';

export class DeepSeekHarnessError extends Error {
  constructor(
    readonly code: DeepSeekHarnessErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DeepSeekHarnessError';
  }
}
