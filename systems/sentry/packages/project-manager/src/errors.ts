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

export function projectCopyFailure(
  code: 'PROJECT_COPY_FAILED' | 'PROJECT_UPDATE_FAILED',
  message: string,
  cause: unknown,
): ProjectManagerError {
  const failure = cause as NodeJS.ErrnoException | undefined;
  if (failure?.code === 'EACCES' || failure?.code === 'EPERM') {
    const path =
      typeof failure.path === 'string'
        ? JSON.stringify(failure.path.slice(0, 600))
        : 'a project path';
    return new ProjectManagerError(
      'PROJECT_SOURCE_UNREADABLE',
      'Cannot read or copy ' +
        path +
        ' (' +
        failure.code +
        '). Check read access to the source and write access to the destination.',
      { cause },
    );
  }
  if (failure?.code === 'ENOSPC' || failure?.code === 'EDQUOT') {
    return new ProjectManagerError(
      'INSUFFICIENT_STORAGE',
      'Not enough disk space to import the project and its immutable revision. On WSL, also free space on the Windows drive holding the Ubuntu disk.',
      { cause },
    );
  }
  return new ProjectManagerError(code, message, { cause });
}
