/**
 * Time representation.
 *
 * Serialized timestamps are always ISO 8601 UTC strings
 * (e.g. 2026-09-09T19:15:31.521Z). Internally the domain also uses
 * these strings so structures serialize cleanly across worker
 * boundaries without Date-object marshalling hazards.
 */

export type IsoTimestamp = string & { readonly __brand: 'IsoTimestamp' };

const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') return false;
  const match = ISO_UTC_RE.exec(value);
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, msText = '0'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(msText.padEnd(3, '0'));

  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, millisecond);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second &&
    parsed.getUTCMilliseconds() === millisecond
  );
}

/** Current time as an ISO 8601 UTC string. */
export function nowIsoTimestamp(date: Date = new Date()): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}
