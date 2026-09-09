/**
 * Domain errors. Expected failures carry a stable `code` (never a bare
 * Error('failed')); serialization is safe (no env/secrets in details).
 */
export type DomainErrorCode =
  | 'INVALID_PROJECT'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_FINDING'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'AGENT_STACK_NOT_FOUND'
  | 'HARNESS_UNAVAILABLE'
  | 'HARNESS_PROTOCOL_ERROR'
  | 'INVALID_STATE_TRANSITION'
  | 'VALIDATION_ERROR';

export interface DomainErrorDetails {
  readonly [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: DomainErrorDetails;

  constructor(
    code: DomainErrorCode,
    message: string,
    options?: { details?: DomainErrorDetails; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
  }

  toJSON(): { name: string; code: DomainErrorCode; message: string; details?: DomainErrorDetails } {
    const out: {
      name: string;
      code: DomainErrorCode;
      message: string;
      details?: DomainErrorDetails;
    } = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export class InvalidProjectError extends DomainError {
  constructor(message = 'Invalid project', details?: DomainErrorDetails) {
    super('INVALID_PROJECT', message, details === undefined ? undefined : { details });
    this.name = 'InvalidProjectError';
  }
}

export class InvalidSnapshotError extends DomainError {
  constructor(message = 'Invalid snapshot', details?: DomainErrorDetails) {
    super('INVALID_SNAPSHOT', message, details === undefined ? undefined : { details });
    this.name = 'InvalidSnapshotError';
  }
}

export class InvalidFindingError extends DomainError {
  constructor(message = 'Invalid finding', details?: DomainErrorDetails) {
    super('INVALID_FINDING', message, details === undefined ? undefined : { details });
    this.name = 'InvalidFindingError';
  }
}

export class UnsupportedSchemaVersionError extends DomainError {
  constructor(version: unknown, details?: DomainErrorDetails) {
    super(
      'UNSUPPORTED_SCHEMA_VERSION',
      'Unsupported schemaVersion: ' + JSON.stringify(version),
      details === undefined ? undefined : { details },
    );
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export class AgentStackNotFoundError extends DomainError {
  constructor(stackId: string, details?: DomainErrorDetails) {
    super(
      'AGENT_STACK_NOT_FOUND',
      'Agent stack not found: ' + stackId,
      details === undefined ? undefined : { details },
    );
    this.name = 'AgentStackNotFoundError';
  }
}

export class HarnessUnavailableError extends DomainError {
  constructor(message = 'Harness unavailable', details?: DomainErrorDetails) {
    super('HARNESS_UNAVAILABLE', message, details === undefined ? undefined : { details });
    this.name = 'HarnessUnavailableError';
  }
}

export class HarnessProtocolError extends DomainError {
  constructor(message = 'Harness protocol error', details?: DomainErrorDetails) {
    super('HARNESS_PROTOCOL_ERROR', message, details === undefined ? undefined : { details });
    this.name = 'HarnessProtocolError';
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(from: string, to: string, entity = 'entity') {
    super('INVALID_STATE_TRANSITION', 'Invalid ' + entity + ' transition: ' + from + ' -> ' + to);
    this.name = 'InvalidStateTransitionError';
  }
}
