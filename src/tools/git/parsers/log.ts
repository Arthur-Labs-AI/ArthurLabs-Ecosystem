/**
 * SC-05 structured log/show parser (spec sections 62-68, 74-79).
 *
 * Machine format only (never user pretty config):
 *   git log --no-notes --no-color --format=...%x1f...%x1e -z-ish
 * We use %x1e (record) / %x1f (field) separators with NUL-safe handling.
 * Author email, signatures, notes, and patches are never requested here;
 * the patch pipeline lives in parsers/diff.ts.
 */

import type { GitLogCommit } from "../contracts";

export const MAX_LOG_COMMITS = 50;
export const MAX_SUBJECT_CHARS = 500;
export const MAX_BODY_CHARS = 4 * 1024;

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/** Build the fixed --format string for log/show metadata. */
export function logFormatString(): string {
  return ["%H", "%P", "%an", "%at", "%ct", "%s", "%b"].join(FIELD_SEP) + RECORD_SEP;
}

function boundText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function parseEpoch(value: string): string {
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid commit timestamp");
  return new Date(n * 1000).toISOString();
}

/** Parse raw log output into bounded commits. */
export function parseLogOutput(stdout: string): { commits: GitLogCommit[]; truncated: boolean } {
  const commits: GitLogCommit[] = [];
  const records = stdout.split(RECORD_SEP);
  let truncated = false;
  for (const record of records) {
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed.length === 0) continue;
    if (commits.length >= MAX_LOG_COMMITS) {
      truncated = true;
      break;
    }
    const fields = trimmed.split(FIELD_SEP);
    if (fields.length < 7) throw new Error("unparseable log record");
    const [oidRaw = "", parentsRaw = "", authorRaw = "", authoredRaw = "", committedRaw = "", subjectRaw = "", bodyRaw = ""] = fields;
    const oid = oidRaw.trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("invalid commit oid");
    const parents = parentsRaw.trim().length === 0 ? [] : parentsRaw.trim().split(" ").filter((p) => p.length > 0);
    for (const p of parents) {
      if (!/^[0-9a-f]{40}$/.test(p)) throw new Error("invalid parent oid");
    }
    commits.push({
      oid,
      short_oid: oid.slice(0, 7),
      parents,
      author_name: boundText(authorRaw, 256),
      authored_at: parseEpoch(authoredRaw),
      committed_at: parseEpoch(committedRaw),
      subject: boundText(subjectRaw.replace(/\n.*/s, "").trim(), MAX_SUBJECT_CHARS),
    });
  }
  void bodyRawSafe(stdout);
  return { commits, truncated };
}

function bodyRawSafe(_stdout: string): void {
  /* Body text is parsed by parseShowBody; log output keeps subject only. */
}

/** Parse a single-commit show metadata record (same format, one record). */
export function parseShowMetadata(stdout: string): {
  oid: string;
  parents: string[];
  author_name: string;
  authored_at: string;
  committed_at: string;
  subject: string;
  body: string;
  body_truncated: boolean;
} {
  const records = stdout.split(RECORD_SEP).map((r) => r.replace(/^\n+/, "")).filter((r) => r.length > 0);
  if (records.length === 0) throw new Error("empty commit metadata");
  const fields = (records[0] ?? "").split(FIELD_SEP);
  if (fields.length < 7) throw new Error("unparseable commit record");
  const [oidRaw = "", parentsRaw = "", authorRaw = "", authoredRaw = "", committedRaw = "", subjectRaw = "", bodyRaw = ""] = fields;
  const oid = oidRaw.trim();
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("invalid commit oid");
  const parents = parentsRaw.trim().length === 0 ? [] : parentsRaw.trim().split(" ").filter((p) => p.length > 0);
  const bodyFull = bodyRaw.replace(/\n$/, "");
  const body_truncated = bodyFull.length > MAX_BODY_CHARS;
  return {
    oid,
    parents,
    author_name: boundText(authorRaw, 256),
    authored_at: parseEpoch(authoredRaw),
    committed_at: parseEpoch(committedRaw),
    subject: boundText(subjectRaw.replace(/\n.*/s, "").trim(), MAX_SUBJECT_CHARS),
    body: boundText(bodyFull, MAX_BODY_CHARS),
    body_truncated,
  };
}
