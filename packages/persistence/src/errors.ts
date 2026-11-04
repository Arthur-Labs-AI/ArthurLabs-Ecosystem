export type RuntimeErrorCode =
  | 'DATABASE_ERROR'
  | 'PERSISTED_DATA_INVALID'
  | 'ARTIFACT_WRITE_FAILED'
  | 'PATH_ESCAPE'
  | 'RUNTIME_LEASE_CONFLICT'
  | 'RUNTIME_LEASE_LOST'
  | 'EVENT_CONFLICT'
  | 'RELATIONSHIP_CONFLICT'
  | 'SQLITE_BUSY';

export class RuntimePersistenceError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RuntimePersistenceError';
  }
}
