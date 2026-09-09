/**
 * Time representation.
 *
 * Serialized timestamps are always ISO 8601 UTC strings
 * (e.g. 2026-09-09T19:15:31.521Z). Internally the domain also uses
 * these strings so structures serialize cleanly across worker
 * boundaries without Date-object marshalling hazards.
 */

export type IsoTimestamp = string & { readonly __brand: 'IsoTimestamp' };

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') return false;
  if (!ISO_UTC_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/** Current time as an ISO 8601 UTC string. */
export function nowIsoTimestamp(date: Date = new Date()): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}
