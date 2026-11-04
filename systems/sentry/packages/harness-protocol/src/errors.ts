export type HarnessProtocolErrorCode =
  | 'INVALID_NDJSON'
  | 'INVALID_HARNESS_EVENT'
  | 'INVALID_EVENT_SEQUENCE'
  | 'AGENT_RUN_MISMATCH'
  | 'QA_RUN_MISMATCH';

export interface HarnessProtocolErrorDetails {
  readonly line?: number;
  readonly eventIndex?: number;
}

/** Expected, safely serializable failures at the harness protocol boundary. */
export class HarnessProtocolError extends Error {
  readonly code: HarnessProtocolErrorCode;
  readonly details?: HarnessProtocolErrorDetails;

  constructor(
    code: HarnessProtocolErrorCode,
    message: string,
    details?: HarnessProtocolErrorDetails,
  ) {
    super(message);
    this.name = 'HarnessProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): {
    name: string;
    code: HarnessProtocolErrorCode;
    message: string;
    details?: HarnessProtocolErrorDetails;
  } {
    const serialized: {
      name: string;
      code: HarnessProtocolErrorCode;
      message: string;
      details?: HarnessProtocolErrorDetails;
    } = { name: this.name, code: this.code, message: this.message };
    if (this.details !== undefined) serialized.details = this.details;
    return serialized;
  }
}
