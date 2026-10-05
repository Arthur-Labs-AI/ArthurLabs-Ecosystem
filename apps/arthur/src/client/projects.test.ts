import { INBOX_PROJECT_ID } from "@arthur/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProjectError, RelationError } from "./arthur-client";
import { createArthurClient } from "./index";
import { createPreviewClient, type PreviewClientOptions } from "./preview-client";
import type { Invoke } from "./tauri-ipc";

const TEXT = "Improve the capture screen. Email Ignatov. Decide on the school essay.";
const THREE: PreviewClientOptions["distillation"] = {
  candidates: () => [
    { kind: "idea", title: "Idea A", body: "Improve the capture screen.", evidence: "Improve the capture screen" },
    { kind: "task", title: "Task B", body: "Email Ignatov.", evidence: "Email Ignatov" },
    { kind: "decision", title: "Decision C", body: "Decide on the school essay.", evidence: "Decide on the school essay" },
  ],
};
const client = (options: PreviewClientOptions = {}) => createPreviewClient({ distillation: THREE, ...options });

describe("projects (preview client mirrors the native rules)", () => {
  it("starts with exactly the Inbox, active, and it cannot be renamed or archived", async () => {
    const c = client();
    const [inbox, ...others] = await c.listProjects({ includeArchived: true });
    expect(others).toEqual([]);
    expect(inbox).toMatchObject({ id: INBOX_PROJECT_ID, name: "Inbox", isInbox: true, archivedAt: null });
    expect((await c.getActiveProject()).id).toBe(INBOX_PROJECT_ID);
    await expect(c.archiveProject(INBOX_PROJECT_ID)).rejects.toMatchObject({ code: "inbox_protected" });
    await expect(c.renameProject(INBOX_PROJECT_ID, "Elsewhere")).rejects.toMatchObject({ code: "inbox_protected" });
    await expect(c.getProject("missing")).rejects.toBeInstanceOf(ProjectError);
  });

  it("creates, lists (Inbox first, then by name), renames and rejects bad or duplicate names", async () => {
    const c = client();
    const nexus = await c.createProject("  Nexus ");
    await c.createProject("Arthur");
    expect(nexus.name).toBe("Nexus");
    expect((await c.listProjects()).map((p) => p.name)).toEqual(["Inbox", "Arthur", "Nexus"]);
    expect((await c.renameProject(nexus.id, "Nexus Core")).name).toBe("Nexus Core");
    for (const bad of ["", "   ", "x".repeat(81)]) await expect(c.createProject(bad)).rejects.toMatchObject({ code: "invalid_project" });
    await expect(c.createProject("arthur")).rejects.toMatchObject({ code: "project_name_taken" });
    await expect(c.createProject("INBOX")).rejects.toMatchObject({ code: "project_name_taken" });
  });

  it("archives (keeping data, accepting nothing new, never active) and restores", async () => {
    const c = client();
    const nexus = await c.createProject("Nexus");
    const capture = await c.createCapture({ source: "text", content: TEXT, projectId: nexus.id });
    await c.setActiveProject(nexus.id);
    expect((await c.getActiveProject()).id).toBe(nexus.id);

    const archived = await c.archiveProject(nexus.id);
    expect(archived.archivedAt).not.toBeNull();
    expect((await c.getActiveProject()).id).toBe(INBOX_PROJECT_ID);
    expect((await c.listProjects()).map((p) => p.id)).toEqual([INBOX_PROJECT_ID]);
    expect((await c.listProjects({ includeArchived: true })).map((p) => p.id)).toContain(nexus.id);
    expect(await c.listCaptures({ projectId: nexus.id })).toEqual([capture]);
    await expect(c.createCapture({ source: "text", content: "x", projectId: nexus.id })).rejects.toThrow("archived");
    await expect(c.setActiveProject(nexus.id)).rejects.toMatchObject({ code: "project_archived" });
    expect((await c.restoreProject(nexus.id)).archivedAt).toBeNull();
    await expect(c.setActiveProject(nexus.id)).resolves.toMatchObject({ id: nexus.id });
  });

  it("a capture belongs to the project it was made in, and distillation inherits it (the model never decides)", async () => {
    const c = client();
    const nexus = await c.createProject("Nexus");
    const inInbox = await c.createCapture({ source: "text", content: TEXT });
    const inNexus = await c.createCapture({ source: "text", content: TEXT, projectId: nexus.id });
    expect(inInbox.projectId).toBe(INBOX_PROJECT_ID);
    expect(inNexus.projectId).toBe(nexus.id);
    expect((await c.distillCapture(inNexus.id)).every((o) => o.projectId === nexus.id)).toBe(true);
    expect((await c.distillCapture(inInbox.id)).every((o) => o.projectId === INBOX_PROJECT_ID)).toBe(true);
    await expect(c.createCapture({ source: "text", content: "x", projectId: "missing" })).rejects.toThrow("does not exist");
  });

  it("scopes captures, objects, organization states and summaries to a project", async () => {
    const c = client();
    const nexus = await c.createProject("Nexus");
    const a = await c.createCapture({ source: "text", content: TEXT });
    const b = await c.createCapture({ source: "text", content: TEXT, projectId: nexus.id });
    await c.distillCapture(a.id);
    await c.distillCapture(b.id);
    expect((await c.listCaptures({ projectId: nexus.id })).map((x) => x.id)).toEqual([b.id]);
    expect(await c.listCaptures()).toHaveLength(2);
    expect(await c.listKnowledgeObjects({ projectId: nexus.id })).toHaveLength(3);
    expect(await c.listKnowledgeObjects()).toHaveLength(6);
    expect((await c.listOrganizationStates({ projectId: nexus.id })).map((s) => s.captureId)).toEqual([b.id]);
    expect(await c.getKnowledgeSummaries(undefined, { projectId: nexus.id })).toHaveLength(3);
    expect((await c.listProjects()).map((p) => [p.name, p.captureCount, p.objectCount])).toEqual([["Inbox", 1, 3], ["Nexus", 1, 3]]);
    expect((await c.getCaptures([a.id, b.id, "x"])).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("moving an object changes only its project: same id, no revision, provenance and lineage intact, capture untouched", async () => {
    const c = client();
    const [arthur, nexus, school] = [await c.createProject("Arthur"), await c.createProject("Nexus"), await c.createProject("School")];
    const capture = await c.createCapture({ source: "text", content: TEXT });
    const [a, b, d] = await c.distillCapture(capture.id);
    await c.updateKnowledgeObject(a!.id, { title: "Idea A, sharper" });
    const lineage = await c.getObjectLineage(a!.id);

    const moved = await Promise.all([c.moveKnowledgeObject(a!.id, arthur.id), c.moveKnowledgeObject(b!.id, nexus.id), c.moveKnowledgeObject(d!.id, school.id)]);

    expect(moved.map((o) => o.projectId)).toEqual([arthur.id, nexus.id, school.id]);
    expect(moved[0]).toMatchObject({ id: a!.id, title: "Idea A, sharper", provenance: a!.provenance });
    expect(await c.getObjectLineage(a!.id)).toEqual(lineage);
    expect(await c.listKnowledgeObjects()).toHaveLength(3);
    expect((await c.getCaptures([capture.id]))[0]).toEqual(capture);
    await expect(c.moveKnowledgeObject("missing", arthur.id)).rejects.toMatchObject({ code: "object_not_found" });
    await expect(c.moveKnowledgeObject(a!.id, "missing")).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("moving a capture does NOT move its objects; objects distilled later follow the capture", async () => {
    const c = client();
    const nexus = await c.createProject("Nexus");
    const organized = await c.createCapture({ source: "text", content: TEXT });
    const objects = await c.distillCapture(organized.id);
    const later = await c.createCapture({ source: "text", content: TEXT });

    const moved = await c.moveCapture(organized.id, nexus.id);
    await c.moveCapture(later.id, nexus.id);

    expect(moved).toMatchObject({ id: organized.id, content: organized.content, createdAt: organized.createdAt, projectId: nexus.id });
    expect((await c.listKnowledgeObjects({ projectId: INBOX_PROJECT_ID })).map((o) => o.id)).toEqual(objects.map((o) => o.id));
    expect((await c.distillCapture(later.id)).every((o) => o.projectId === nexus.id)).toBe(true);
    await expect(c.moveCapture("missing", nexus.id)).rejects.toMatchObject({ code: "capture_not_found" });
  });

  it("project graphs include cross-project relations and mark the far end, without expanding into the other project", async () => {
    const c = client();
    const nexus = await c.createProject("Nexus");
    const capture = await c.createCapture({ source: "text", content: TEXT });
    const [a, b, d] = await c.distillCapture(capture.id);
    await c.moveKnowledgeObject(b!.id, nexus.id);
    await c.moveKnowledgeObject(d!.id, nexus.id);
    const cross = await c.createRelation({ kind: "depends_on", sourceObjectId: a!.id, targetObjectId: b!.id });
    await c.createRelation({ kind: "related_to", sourceObjectId: b!.id, targetObjectId: d!.id });

    const inbox = await c.getProjectGraph(INBOX_PROJECT_ID);
    expect(inbox.objects.map((o) => o.id)).toEqual([a!.id]);
    expect(inbox.relations).toEqual([cross]);
    expect(inbox.externalObjects).toEqual([{ id: b!.id, kind: "task", title: "Task B", projectId: nexus.id, projectName: "Nexus" }]);
    expect(inbox.externalObjects.some((o) => o.id === d!.id)).toBe(false);

    const there = await c.getProjectGraph(nexus.id);
    expect(there.relations).toHaveLength(2);
    expect(there.externalObjects.map((o) => o.projectName)).toEqual(["Inbox"]);
    await expect(c.getProjectGraph("missing")).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("inference is project-local: the model sees one project, and a mixed request is refused", async () => {
    const seen: string[][] = [];
    const c = client({ inference: { proposals: (objects) => (seen.push(objects.map((o) => o.title)), []) } });
    const nexus = await c.createProject("Nexus");
    const a = await c.createCapture({ source: "text", content: TEXT });
    const b = await c.createCapture({ source: "text", content: TEXT, projectId: nexus.id });
    const [inboxObjects, nexusObjects] = [await c.distillCapture(a.id), await c.distillCapture(b.id)];

    await c.inferRelations(undefined, { projectId: nexus.id });
    await c.inferRelations([inboxObjects[0]!.id]);
    expect(seen).toHaveLength(2);
    expect(seen.every((titles) => titles.length === 3)).toBe(true); // three, not six
    await expect(c.inferRelations([inboxObjects[0]!.id, nexusObjects[0]!.id])).rejects.toBeInstanceOf(RelationError);
    await expect(c.inferRelations([inboxObjects[0]!.id], { projectId: nexus.id })).rejects.toBeInstanceOf(RelationError);
  });
});

describe("projects over IPC", () => {
  const project = { id: "p1", name: "Nexus", isInbox: false, createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z", archivedAt: null, captureCount: 0, objectCount: 0 };
  const android = { isTauri: true, tauriPlatform: "android" };
  const make = (reply: unknown) => {
    const call = vi.fn<Invoke>().mockResolvedValue(reply);
    return { call, client: createArthurClient(android, call) };
  };

  it("calls exactly the documented commands with exactly the documented arguments", async () => {
    const { call, client: c } = make(project);
    await c.createProject("Nexus");
    await c.renameProject("p1", "Core");
    await c.archiveProject("p1");
    await c.restoreProject("p1");
    await c.setActiveProject("p1");
    await c.getActiveProject();
    await c.getProject("p1");
    expect(call.mock.calls).toEqual([
      ["create_project", { name: "Nexus" }],
      ["rename_project", { projectId: "p1", name: "Core" }],
      ["archive_project", { projectId: "p1" }],
      ["restore_project", { projectId: "p1" }],
      ["set_active_project", { projectId: "p1" }],
      ["get_active_project", undefined],
      ["get_project", { projectId: "p1" }],
    ]);
  });

  it("lists projects with or without archived ones and validates the answer", async () => {
    const { call, client: c } = make([project]);
    expect(await c.listProjects()).toEqual([project]);
    await c.listProjects({ includeArchived: true });
    expect(call.mock.calls).toEqual([["list_projects", undefined], ["list_projects", { includeArchived: true }]]);
    await expect(make([{ ...project, name: "" }]).client.listProjects()).rejects.toThrow("invalid projects");
    await expect(make({ ...project, archivedAt: 5 }).client.getProject("p1")).rejects.toThrow("invalid project");
    await expect(make({ ...project, captureCount: -1 }).client.getProject("p1")).rejects.toThrow("invalid project");
  });

  it("validates names before the native layer is called, and never sends anything else", async () => {
    const { call, client: c } = make(project);
    await expect(c.createProject("   ")).rejects.toMatchObject({ code: "invalid_project" });
    await expect(c.renameProject("p1", "x".repeat(81))).rejects.toMatchObject({ code: "invalid_project" });
    await expect(c.archiveProject("")).rejects.toThrow("Invalid project id");
    expect(call).not.toHaveBeenCalled();
  });

  it("turns native failures into ProjectErrors and passes other failures through", async () => {
    const failing = vi.fn<Invoke>().mockRejectedValue({ code: "project_name_taken", message: "Another project already has that name." });
    await expect(createArthurClient(android, failing).createProject("Nexus")).rejects.toMatchObject({ name: "ProjectError", code: "project_name_taken", message: "Another project already has that name." });
    const odd = new Error("boom");
    await expect(createArthurClient(android, vi.fn<Invoke>().mockRejectedValue(odd)).getActiveProject()).rejects.toBe(odd);
  });

  it("moves captures and objects by id only and validates what comes back", async () => {
    const capture = { id: "c1", source: "text", content: "hi", createdAt: "2026-10-05T10:00:00Z", projectId: "p1" };
    const { call, client: c } = make(capture);
    expect(await c.moveCapture("c1", "p1")).toEqual(capture);
    expect(call).toHaveBeenCalledExactlyOnceWith("move_capture", { captureId: "c1", projectId: "p1" });
    await expect(make({ ...capture, projectId: "" }).client.moveCapture("c1", "p1")).rejects.toThrow("invalid capture");
    await expect(make({}).client.moveKnowledgeObject("o1", "p1")).rejects.toThrow("invalid knowledge object");
    await expect(c.moveKnowledgeObject("o1", "")).rejects.toThrow("Invalid project id");
  });

  it("sends the project scope only when there is one, so unscoped calls are exactly as before", async () => {
    const { call, client: c } = make([]);
    await c.listCaptures();
    await c.listCaptures({ projectId: "p1" });
    await c.listKnowledgeObjects({ projectId: "p1" });
    await c.listOrganizationStates({ projectId: "p1" });
    await c.getKnowledgeSummaries(["a"], { projectId: "p1" });
    await c.inferRelations(["a"], { projectId: "p1" });
    await c.inferRelations();
    expect(call.mock.calls).toEqual([
      ["list_captures"],
      ["list_captures", { projectId: "p1" }],
      ["list_knowledge_objects", { projectId: "p1" }],
      ["list_organization_states", { projectId: "p1" }],
      ["get_knowledge_summaries", { objectIds: ["a"], projectId: "p1" }],
      ["infer_relations", { objectIds: ["a"], projectId: "p1" }],
      ["infer_relations", undefined],
    ]);
  });

  it("voice captures carry the project of the moment, and getCaptures is one bounded request", async () => {
    const voice = { id: "c1", source: "voice", content: "said", createdAt: "2026-10-05T10:00:00Z", projectId: "p1" };
    const { call, client: c } = make(voice);
    await c.finishVoiceCapture("p1");
    await c.retryVoiceTranscription("p1");
    expect(call.mock.calls).toEqual([["finish_voice_capture", { projectId: "p1" }], ["retry_voice_transcription", { projectId: "p1" }]]);
    const lookup = make([voice]);
    expect(await lookup.client.getCaptures(["c1"])).toEqual([voice]);
    expect(lookup.call).toHaveBeenCalledExactlyOnceWith("get_captures", { captureIds: ["c1"] });
    expect(await lookup.client.getCaptures([])).toEqual([]);
    expect(lookup.call).toHaveBeenCalledTimes(1);
    await expect(lookup.client.getCaptures(Array.from({ length: 1001 }, (_, i) => `c${i}`))).rejects.toThrow("Invalid capture ids");
  });

  it("reads project graphs and validates every part of them", async () => {
    const graph = { projectId: "p1", objects: [], relations: [], externalObjects: [{ id: "o1", kind: "idea", title: "Far", projectId: "p2", projectName: "Other" }] };
    const { call, client: c } = make(graph);
    expect(await c.getProjectGraph("p1")).toEqual(graph);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_project_graph", { projectId: "p1" });
    await expect(make({ ...graph, externalObjects: [{ id: "o1", kind: "weird", title: "x", projectId: "p2", projectName: "O" }] }).client.getProjectGraph("p1")).rejects.toThrow("invalid project graph");
    await expect(make({ ...graph, relations: [{}] }).client.getProjectGraph("p1")).rejects.toThrow("invalid project graph");
  });
});
