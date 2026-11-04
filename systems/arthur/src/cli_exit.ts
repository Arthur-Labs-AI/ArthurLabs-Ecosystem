/**
 * HR-02.5F: deterministic CLI exit codes (models/setup commands).
 *
 * The historical CLI surface uses 0/1 only; model commands distinguish
 * operator-actionable outcomes so scripts can react without parsing
 * text. JSON mode mirrors the same code string in the envelope.
 */

export const CliExit = {
  SUCCESS: 0,
  USAGE: 2,
  INCOMPATIBLE: 3,
  AUTH_REQUIRED: 4,
  VALIDATION_FAILED: 5,
  INTERNAL: 1,
} as const;

export type CliExitCode = (typeof CliExit)[keyof typeof CliExit];

const CODE_BY_ERROR: Record<string, CliExitCode> = {
  INVALID_REQUEST: CliExit.USAGE,
  INVALID_CONFIG: CliExit.USAGE,
  TOOL_CAPABILITY_UNAVAILABLE: CliExit.INCOMPATIBLE,
};

export function exitCodeFor(errorCode: string): CliExitCode {
  return CODE_BY_ERROR[errorCode] ?? CliExit.INTERNAL;
}

export const CliErrorCode = {
  USAGE: 'USAGE',
  INCOMPATIBLE: 'INCOMPATIBLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FAILED: 'FAILED',
  INTERNAL: 'INTERNAL',
} as const;
