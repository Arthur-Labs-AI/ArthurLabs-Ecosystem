/**
 * Project contracts (M03.2).
 *
 * A Project (Knowledge Space) is a real domain boundary, not a UI filter. It owns Captures and KnowledgeObjects
 * (`Capture.projectId`, `KnowledgeObject.projectId`). Nothing else carries a project: a revision belongs to the project
 * of its object, a relation derives the projects of its two endpoints, and provenance is independent of membership.
 *
 * There is always exactly one system Inbox. It cannot be archived, renamed or deleted. Projects are archived, never deleted.
 */

import { isKnowledgeObject, isCognitiveRelation, type CognitiveRelation, type KnowledgeObject, type KnowledgeObjectKind, isKnowledgeObjectKind } from "./cognitive";

/** The id of the system Inbox project; the same on every device and in every database. */
export const INBOX_PROJECT_ID = "00000000-0000-4000-8000-000000000001";

/** Mirrored by the native store; keep both in sync. */
export const MAX_PROJECT_NAME_CHARS = 80;

export interface Project {
  /** Assigned by the store; unique and stable. */
  id: string;
  name: string;
  /** True only for the system Inbox. */
  isInbox: boolean;
  /** ISO-8601 (RFC 3339). */
  createdAt: string;
  updatedAt: string;
  /** Set while the project is archived. An archived project keeps its data but accepts no new Captures or objects. */
  archivedAt: string | null;
  /** Derived counts, from one bounded query. */
  captureCount: number;
  objectCount: number;
}

/** The far end of a cross-project relation: enough to mark it and name its project, never its whole project. */
export interface ExternalObject {
  id: string;
  kind: KnowledgeObjectKind;
  title: string;
  projectId: string;
  projectName: string;
}

/**
 * The graph projection of one project: its own objects, every relation touching them, and the other endpoints of the
 * cross-project relations. The remaining objects of other projects are never included.
 */
export interface ProjectGraph {
  projectId: string;
  objects: KnowledgeObject[];
  relations: CognitiveRelation[];
  externalObjects: ExternalObject[];
}

/** What a list or query is confined to. Omitted means every project (internal use, and the future "all projects" recall). */
export interface ProjectScope {
  projectId?: string;
}

export const PROJECT_ERROR_CODES = [
  "project_not_found",
  "capture_not_found",
  "object_not_found",
  "invalid_project",
  "project_name_taken",
  "project_archived",
  "inbox_protected",
  "storage_failed",
] as const;

export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

export interface ProjectErrorPayload {
  code: ProjectErrorCode;
  /** Safe to show to the user. */
  message: string;
}

export function isProjectErrorCode(value: unknown): value is ProjectErrorCode {
  return typeof value === "string" && (PROJECT_ERROR_CODES as readonly string[]).includes(value);
}

export function isProjectErrorPayload(value: unknown): value is ProjectErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isProjectErrorCode(candidate.code) && typeof candidate.message === "string";
}

export function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.name === "string" &&
    c.name.trim().length > 0 &&
    typeof c.isInbox === "boolean" &&
    typeof c.createdAt === "string" &&
    c.createdAt.length > 0 &&
    typeof c.updatedAt === "string" &&
    c.updatedAt.length > 0 &&
    (c.archivedAt === null || (typeof c.archivedAt === "string" && c.archivedAt.length > 0)) &&
    count(c.captureCount) &&
    count(c.objectCount)
  );
}

export function isExternalObject(value: unknown): value is ExternalObject {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    isKnowledgeObjectKind(c.kind) &&
    typeof c.title === "string" &&
    typeof c.projectId === "string" &&
    c.projectId.length > 0 &&
    typeof c.projectName === "string"
  );
}

export function isProjectGraph(value: unknown): value is ProjectGraph {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.projectId === "string" &&
    c.projectId.length > 0 &&
    Array.isArray(c.objects) &&
    c.objects.every(isKnowledgeObject) &&
    Array.isArray(c.relations) &&
    c.relations.every(isCognitiveRelation) &&
    Array.isArray(c.externalObjects) &&
    c.externalObjects.every(isExternalObject)
  );
}

/** Returns why `name` is not a valid project name, or `null` when it is valid. Mirrors the native validation. */
export function describeProjectNameProblem(name: unknown): string | null {
  if (typeof name !== "string") return "name must be a string";
  const trimmed = name.trim();
  if (trimmed.length === 0) return "it is empty";
  if ([...trimmed].length > MAX_PROJECT_NAME_CHARS) return `it is longer than ${MAX_PROJECT_NAME_CHARS} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return "it contains control characters";
  return null;
}
