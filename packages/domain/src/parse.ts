/**
 * Serialization boundary. External JSON is never trusted: every entry
 * point parses through the Zod schema and converts failures into
 * DomainError (VALIDATION_ERROR / UNSUPPORTED_SCHEMA_VERSION). Validated
 * values are then treated as trusted domain data (no re-parsing inside).
 */
import type { z } from 'zod';
import { DomainError, UnsupportedSchemaVersionError } from './errors.js';

export interface ParseResult<T> {
  readonly ok: true;
  readonly value: T;
}

export function parseDomain<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  if (typeof input === 'object' && input !== null && 'schemaVersion' in input) {
    const v = (input as { schemaVersion?: unknown }).schemaVersion;
    if (typeof v === 'number' && v !== 1) throw new UnsupportedSchemaVersionError(v, { label });
  }
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new DomainError(
    'VALIDATION_ERROR',
    'Invalid ' +
      label +
      ': ' +
      result.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '),
    {
      details: {
        label,
        issues: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      },
    },
  );
}

export function toSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
