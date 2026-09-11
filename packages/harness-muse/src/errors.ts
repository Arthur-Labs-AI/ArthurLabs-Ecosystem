export type MuseHarnessErrorCode =
  | 'MUSE_STACK_UNAVAILABLE'
  | 'MUSE_BINARY_NOT_FOUND'
  | 'MUSE_MODEL_NOT_CONFIGURED'
  | 'MUSE_START_FAILED'
  | 'MUSE_AUTH_FAILED'
  | 'MUSE_SANDBOX_UNAVAILABLE'
  | 'MUSE_INVALID_RESULT'
  | 'MUSE_SUBAGENT_FORBIDDEN'
  | 'MUSE_CANCEL_FAILED';

export class MuseHarnessError extends Error {
  constructor(
    readonly code: MuseHarnessErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MuseHarnessError';
  }
}
