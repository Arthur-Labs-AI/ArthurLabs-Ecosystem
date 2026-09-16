export type ProjectManagerErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_SOURCE_NOT_FOUND'
  | 'PROJECT_SOURCE_UNREADABLE'
  | 'PROJECT_PATH_OVERLAP'
  | 'PROJECT_COPY_FAILED'
  | 'PROJECT_UPDATE_FAILED'
  | 'PROJECT_DELETE_FAILED'
  | 'PROJECT_LOCKED'
  | 'ACTIVE_RUN_EXISTS'
  | 'RUNTIME_LEASE_REQUIRED'
  | 'PROJECT_COPY_DRIFT'
  | 'REVISION_MATERIAL_CORRUPT'
  | 'INSUFFICIENT_STORAGE';

export class ProjectManagerError extends Error {
  constructor(
    readonly code: ProjectManagerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProjectManagerError';
  }
}
