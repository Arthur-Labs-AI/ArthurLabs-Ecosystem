/**
 * ARTHUR error model (spec section 16).
 *
 * Every failure surfaces as a typed `ArthurError` carrying a stable machine-
 * readable `code` plus a human-readable `message`. `INVALID_CONFIG` is a small
 * extension beyond the runtime table used only for startup validation.
 */

import { SecretSanitizer } from "../../security/sanitize";

export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SESSION_NOT_FOUND"
  | "MODE_VIOLATION"
  | "MODEL_UNAVAILABLE"
  | "MODEL_TIMEOUT"
  | "MODEL_BAD_RESPONSE"
  | "TOOL_NOT_FOUND"
  | "TOOL_ARGUMENT_INVALID"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_OUTPUT_INVALID"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "INTERNAL_ERROR"
  | "INVALID_CONFIG";

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SESSION_NOT_FOUND: 404,
  MODE_VIOLATION: 403,
  MODEL_UNAVAILABLE: 503,
  MODEL_TIMEOUT: 504,
  MODEL_BAD_RESPONSE: 502,
  TOOL_NOT_FOUND: 400,
  TOOL_ARGUMENT_INVALID: 400,
  TOOL_PERMISSION_DENIED: 403,
  TOOL_EXECUTION_FAILED: 500,
  TOOL_OUTPUT_INVALID: 500,
  APPROVAL_REQUIRED: 409,
  APPROVAL_INVALID: 400,
  INTERNAL_ERROR: 500,
  INVALID_CONFIG: 500,
};

export interface ArthurErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  /** When false, `details` are omitted from any client-facing serialization. */
  exposeDetails?: boolean;
}

export class ArthurError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly exposeDetails: boolean;

  constructor(code: ErrorCode, message: string, opts: ArthurErrorOptions = {}) {
    super(message);
    this.name = "ArthurError";
    this.code = code;
    this.details = opts.details;
    this.exposeDetails = opts.exposeDetails ?? false;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  /** Safe, client-facing shape. Never includes stack traces or internal cause. */
  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    const genericSanitizer = new SecretSanitizer([]);
    const body: { code: ErrorCode; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: genericSanitizer.sanitizeText(this.message),
    };
    if (this.exposeDetails && this.details) {
      body.details = genericSanitizer.sanitizeValue(this.details);
    }
    return { error: body };
  }
}

/** Map any thrown value to a typed ArthurError without leaking internals. */
export function toArthurError(err: unknown): ArthurError {
  if (err instanceof ArthurError) {
    return err;
  }
  return new ArthurError("INTERNAL_ERROR", "Unexpected internal failure", { cause: err });
}

export interface PublicError {
  status: number;
  body: { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };
}

/** Single boundary for every user-facing error representation. */
export function sanitizePublicError(err: unknown, sanitizer: SecretSanitizer = new SecretSanitizer([])): PublicError {
  const arthur = toArthurError(err);
  const body: PublicError["body"] = {
    error: {
      code: arthur.code,
      message: sanitizer.sanitizeText(arthur.message),
    },
  };
  if (arthur.exposeDetails && arthur.details) {
    body.error.details = sanitizer.sanitizeValue(arthur.details);
  }
  return { status: arthur.httpStatus, body };
}

export function unsupportedMediaType(): ArthurError {
  return new ArthurError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
}

// ---- Convenience constructors -------------------------------------------

export function invalidRequest(message: string, details?: Record<string, unknown>): ArthurError {
  return new ArthurError("INVALID_REQUEST", message, { details, exposeDetails: true });
}

export function sessionNotFound(sessionId: string): ArthurError {
  return new ArthurError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, {
    details: { session_id: sessionId },
    exposeDetails: true,
  });
}

export function modeViolation(message: string, details?: Record<string, unknown>): ArthurError {
  return new ArthurError("MODE_VIOLATION", message, { details, exposeDetails: true });
}

export function approvalInvalid(message: string, details?: Record<string, unknown>): ArthurError {
  return new ArthurError("APPROVAL_INVALID", message, { details, exposeDetails: true });
}
