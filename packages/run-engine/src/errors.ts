export type RunEngineErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_COMPLETE'
  | 'PROJECT_NOT_FOUND'
  | 'AGENT_STACK_NOT_FOUND'
  | 'RUN_EXECUTION_FAILED';

export class RunEngineError extends Error {
  constructor(
    readonly code: RunEngineErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RunEngineError';
  }
}
