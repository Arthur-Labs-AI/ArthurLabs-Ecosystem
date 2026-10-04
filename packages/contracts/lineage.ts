/**
 * Thought Lineage contracts (M03).
 *
 * Three separate systems, never mixed:
 *   - Capture provenance:  KnowledgeObject -> the exact span of a raw Capture it was interpreted from.
 *   - Cognitive Graph:     KnowledgeObject -> KnowledgeObject (how two objects relate).
 *   - Thought Lineage:     how ONE KnowledgeObject evolved: a DAG of immutable revisions.
 *
 * A KnowledgeObject keeps one stable id. A `ThoughtRevision` is an immutable snapshot of that object's
 * kind/title/body. The object's current state is the revision `ObjectLineage.currentRevisionId` points at.
 * Graph `supersedes` (one object replaces another object) is unrelated to revisions (one object's own history).
 */

import type { KnowledgeObjectKind, KnowledgeProvenance } from "./cognitive";
import { isKnowledgeObjectKind, isKnowledgeProvenance } from "./cognitive";

export const REVISION_ORIGINS = ["initial", "user_edit", "distillation", "merge", "system"] as const;

export type RevisionOrigin = (typeof REVISION_ORIGINS)[number];

/** Mirrored by the native store; keep both in sync. */
export const MAX_MERGE_PARENTS = 8;
export const MAX_REVISIONS_PER_OBJECT = 1_000;

export interface ThoughtRevision {
  /** Assigned by the store; unique and stable. */
  id: string;
  objectId: string;
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  /** ISO-8601 (RFC 3339) timestamp assigned by the store. */
  createdAt: string;
  origin: RevisionOrigin;
  /**
   * Where THIS revision's text came from in a raw Capture, if it genuinely did. The initial revision keeps the
   * object's original source span. A user edit or a merge has none: edited text is never claimed to come from
   * the Capture. Only a revision interpreted from a NEW Capture carries that Capture's span.
   */
  provenance?: KnowledgeProvenance;
  /**
   * Parent revisions of the same object. Initial: none. Edit or branch: exactly one. Merge: two or more.
   * Ordered by when the parents were created (oldest first), so the order is deterministic.
   */
  parentRevisionIds: string[];
}

/** The whole history of one object. Revisions are oldest first, so a parent always precedes its children. */
export interface ObjectLineage {
  objectId: string;
  /** The revision the object currently represents. */
  currentRevisionId: string;
  revisions: ThoughtRevision[];
}

/** A partial change relative to a parent revision. At least one field must actually differ from it. */
export interface RevisionChanges {
  kind?: KnowledgeObjectKind;
  title?: string;
  body?: string;
}

export interface CreateRevisionInput {
  objectId: string;
  /** The revision this one continues from. May be any revision of the object, including an old one (a branch). */
  parentRevisionId: string;
  changes: RevisionChanges;
  /** Default false: a branch does not silently replace the object's current state. */
  makeCurrent?: boolean;
}

export interface MergeRevisionsInput {
  objectId: string;
  /** Two or more distinct revisions of the object. */
  parentRevisionIds: string[];
  /** The caller supplies the merged content; nothing is merged automatically. */
  result: { kind: KnowledgeObjectKind; title: string; body: string };
  /** Default false. */
  makeCurrent?: boolean;
}

export const LINEAGE_ERROR_CODES = ["object_not_found", "revision_not_found", "invalid_revision", "storage_failed"] as const;

export type LineageErrorCode = (typeof LINEAGE_ERROR_CODES)[number];

export interface LineageErrorPayload {
  code: LineageErrorCode;
  /** Safe to show to the user. */
  message: string;
}

export function isRevisionOrigin(value: unknown): value is RevisionOrigin {
  return typeof value === "string" && (REVISION_ORIGINS as readonly string[]).includes(value);
}

export function isLineageErrorPayload(value: unknown): value is LineageErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string" && (LINEAGE_ERROR_CODES as readonly string[]).includes(candidate.code) && typeof candidate.message === "string";
}

export function isThoughtRevision(value: unknown): value is ThoughtRevision {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const stringField = (field: unknown): boolean => typeof field === "string" && field.length > 0;
  if (
    !stringField(c.id) ||
    !stringField(c.objectId) ||
    !isKnowledgeObjectKind(c.kind) ||
    typeof c.title !== "string" ||
    c.title.trim().length === 0 ||
    typeof c.body !== "string" ||
    c.body.trim().length === 0 ||
    !stringField(c.createdAt) ||
    !isRevisionOrigin(c.origin) ||
    !Array.isArray(c.parentRevisionIds) ||
    !c.parentRevisionIds.every((id) => typeof id === "string" && id.length > 0 && id !== c.id) ||
    new Set(c.parentRevisionIds).size !== c.parentRevisionIds.length
  ) {
    return false;
  }
  if (c.provenance !== undefined && !isKnowledgeProvenance(c.provenance)) return false;
  // Parent counts by origin: the DAG shape rules.
  const parents = c.parentRevisionIds.length;
  if (c.origin === "initial") return parents === 0;
  if (c.origin === "merge") return parents >= 2;
  return parents === 1;
}

export function isObjectLineage(value: unknown): value is ObjectLineage {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.objectId !== "string" || typeof c.currentRevisionId !== "string" || !Array.isArray(c.revisions)) return false;
  if (!c.revisions.every(isThoughtRevision)) return false;
  const revisions = c.revisions as ThoughtRevision[];
  const ids = new Set(revisions.map((r) => r.id));
  return (
    revisions.length > 0 &&
    ids.size === revisions.length &&
    ids.has(c.currentRevisionId) &&
    revisions.every((r) => r.objectId === c.objectId) &&
    // oldest first: every parent appears earlier than its child, which also rules out a cycle
    revisions.every((r, index) => r.parentRevisionIds.every((p) => revisions.findIndex((x) => x.id === p) >= 0 && revisions.findIndex((x) => x.id === p) < index))
  );
}

/** Returns why `changes` is not an acceptable edit of `base`, or `null` when it is. */
export function describeRevisionChangesProblem(base: { kind: string; title: string; body: string }, changes: unknown): string | null {
  if (typeof changes !== "object" || changes === null) return "changes must be an object";
  const c = changes as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!["kind", "title", "body"].includes(key)) return `unknown field "${key}"`;
  if (c.kind !== undefined && !isKnowledgeObjectKind(c.kind)) return "unknown kind";
  for (const field of ["title", "body"] as const) {
    if (c[field] !== undefined && (typeof c[field] !== "string" || (c[field] as string).trim().length === 0)) return `${field} must not be empty`;
  }
  const next = { kind: c.kind ?? base.kind, title: c.title ?? base.title, body: c.body ?? base.body };
  if (next.kind === base.kind && next.title === base.title && next.body === base.body) return "nothing changed";
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Deterministic revision diff. No model is involved: the same two revisions always give the same result.
// The native layer implements the identical algorithm (storage-independent `lineage::diff`); both are
// checked against the same fixture file (tests/fixtures/revision_diff_cases.json).
// ---------------------------------------------------------------------------------------------------------

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

export interface TextDiff {
  changed: boolean;
  /** Consecutive segments with the same op are merged. Concatenating equal+delete gives the old text, equal+insert the new. */
  segments: DiffSegment[];
}

export interface RevisionDiff {
  oldRevisionId: string;
  newRevisionId: string;
  kind: { changed: boolean; from: KnowledgeObjectKind; to: KnowledgeObjectKind };
  title: TextDiff;
  body: TextDiff;
}

/**
 * Tokens: a run of letters/digits, a run of white space, or a single other code point (punctuation, an
 * emoji, a combining piece). Unicode properties are used on both sides so Bulgarian text and emoji tokenize identically.
 */
const TOKEN = /[\p{Alphabetic}\p{N}]+|\p{White_Space}+|[\s\S]/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/**
 * Word-level diff by longest common subsequence. Ties are broken the same way everywhere: at a mismatch, prefer
 * to DELETE the old token when that loses nothing, otherwise INSERT the new one, so a replacement reads
 * "delete old, insert new". Common prefix and suffix tokens are trimmed first.
 */
export function diffText(oldText: string, newText: string): TextDiff {
  if (oldText === newText) return { changed: false, segments: oldText.length === 0 ? [] : [{ op: "equal", text: oldText }] };
  const a = tokenize(oldText);
  const b = tokenize(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const n = middleA.length;
  const m = middleB.length;
  const width = m + 1;
  // lcs[i * width + j] = LCS length of middleA[i..] and middleB[j..]. Bodies are bounded (2,000 characters).
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = middleA[i] === middleB[j] ? (lcs[(i + 1) * width + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += text;
    else segments.push({ op, text });
  };
  if (start > 0) push("equal", a.slice(0, start).join(""));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && middleA[i] === middleB[j]) {
      push("equal", middleA[i] as string);
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && (lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number))) {
      push("delete", middleA[i] as string);
      i += 1;
    } else {
      push("insert", middleB[j] as string);
      j += 1;
    }
  }
  if (endA < a.length) push("equal", a.slice(endA).join(""));
  return { changed: true, segments };
}

export function diffRevisionContent(
  oldRevision: { id: string; kind: KnowledgeObjectKind; title: string; body: string },
  newRevision: { id: string; kind: KnowledgeObjectKind; title: string; body: string },
): RevisionDiff {
  return {
    oldRevisionId: oldRevision.id,
    newRevisionId: newRevision.id,
    kind: { changed: oldRevision.kind !== newRevision.kind, from: oldRevision.kind, to: newRevision.kind },
    title: diffText(oldRevision.title, newRevision.title),
    body: diffText(oldRevision.body, newRevision.body),
  };
}

function isTextDiff(value: unknown): value is TextDiff {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.changed === "boolean" &&
    Array.isArray(c.segments) &&
    c.segments.every((s) => typeof s === "object" && s !== null && ["equal", "insert", "delete"].includes((s as DiffSegment).op) && typeof (s as DiffSegment).text === "string")
  );
}

export function isRevisionDiff(value: unknown): value is RevisionDiff {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const kind = c.kind as Record<string, unknown> | undefined;
  return (
    typeof c.oldRevisionId === "string" &&
    typeof c.newRevisionId === "string" &&
    typeof kind === "object" &&
    kind !== null &&
    typeof kind.changed === "boolean" &&
    isKnowledgeObjectKind(kind.from) &&
    isKnowledgeObjectKind(kind.to) &&
    isTextDiff(c.title) &&
    isTextDiff(c.body)
  );
}
