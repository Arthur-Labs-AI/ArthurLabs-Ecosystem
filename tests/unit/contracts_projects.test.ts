import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INBOX_PROJECT_ID,
  MAX_PROJECT_NAME_CHARS,
  PROJECT_ERROR_CODES,
  describeCreateCaptureInputProblem,
  describeProjectNameProblem,
  isCapture,
  isKnowledgeObject,
  isProject,
  isProjectErrorPayload,
  isProjectGraph,
} from "../../packages/contracts";

const project = { id: "p1", name: "Nexus", isInbox: false, createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z", archivedAt: null, captureCount: 2, objectCount: 5 };
const object = { id: "o1", kind: "idea", title: "t", body: "b", createdAt: "2026-10-05T10:00:00Z", provenance: { captureId: "c1", sourceStart: 0, sourceEnd: 1 }, projectId: "p1" };

test("the Inbox has one fixed id that every database agrees on", () => {
  assert.equal(INBOX_PROJECT_ID, "00000000-0000-4000-8000-000000000001");
});

test("a Capture and a KnowledgeObject belong to a project; one without is not valid", () => {
  const capture = { id: "c1", source: "text", content: "hi", createdAt: "2026-10-05T10:00:00Z", projectId: "p1" };
  assert.equal(isCapture(capture), true);
  assert.equal(isCapture({ ...capture, projectId: undefined }), false);
  assert.equal(isCapture({ ...capture, projectId: "" }), false);
  assert.equal(isKnowledgeObject(object), true);
  assert.equal(isKnowledgeObject({ ...object, projectId: undefined }), false);
});

test("creating a capture may name a project, which must be a non-empty string", () => {
  assert.equal(describeCreateCaptureInputProblem({ source: "text", content: "x" }), null, "omitted means the Inbox");
  assert.equal(describeCreateCaptureInputProblem({ source: "text", content: "x", projectId: "p1" }), null);
  assert.match(describeCreateCaptureInputProblem({ source: "text", content: "x", projectId: "" }) ?? "", /projectId/);
  assert.match(describeCreateCaptureInputProblem({ source: "text", content: "x", projectId: 7 }) ?? "", /projectId/);
});

test("project names are validated like the native store does", () => {
  assert.equal(describeProjectNameProblem("A.R.T.H.U.R"), null);
  assert.equal(describeProjectNameProblem("  Нексус  "), null);
  assert.equal(describeProjectNameProblem("x".repeat(MAX_PROJECT_NAME_CHARS)), null);
  for (const bad of ["", "   ", "x".repeat(MAX_PROJECT_NAME_CHARS + 1), "bell\u0007", 5, null]) assert.notEqual(describeProjectNameProblem(bad), null, String(bad));
});

test("isProject accepts only a complete, sensible project", () => {
  assert.equal(isProject(project), true);
  assert.equal(isProject({ ...project, archivedAt: "2026-10-06T10:00:00Z" }), true);
  for (const bad of [null, {}, { ...project, name: " " }, { ...project, isInbox: "no" }, { ...project, archivedAt: "" }, { ...project, archivedAt: 3 }, { ...project, captureCount: -1 }, { ...project, objectCount: 1.5 }]) {
    assert.equal(isProject(bad), false, JSON.stringify(bad));
  }
});

test("a project graph carries its own objects, the relations touching them and only the far ends of cross-project ones", () => {
  const graph = { projectId: "p1", objects: [object], relations: [], externalObjects: [{ id: "o2", kind: "task", title: "far", projectId: "p2", projectName: "Other" }] };
  assert.equal(isProjectGraph(graph), true);
  for (const bad of [{ ...graph, projectId: "" }, { ...graph, objects: [{}] }, { ...graph, relations: [{}] }, { ...graph, externalObjects: [{ ...graph.externalObjects[0], kind: "weird" }] }, { ...graph, externalObjects: [{ id: "o2" }] }]) {
    assert.equal(isProjectGraph(bad), false);
  }
});

test("project errors use a closed set of codes", () => {
  assert.deepEqual([...PROJECT_ERROR_CODES].sort(), ["capture_not_found", "inbox_protected", "invalid_project", "object_not_found", "project_archived", "project_name_taken", "project_not_found", "storage_failed"]);
  assert.equal(isProjectErrorPayload({ code: "inbox_protected", message: "x" }), true);
  assert.equal(isProjectErrorPayload({ code: "nope", message: "x" }), false);
  assert.equal(isProjectErrorPayload({ code: "inbox_protected" }), false);
});
