import { describe, expect, it, vi } from "vitest";
import { MAX_MERGE_PARENTS, type KnowledgeObject, type ThoughtRevision } from "@arthur/contracts";
import { LineageError } from "./arthur-client";
import { createArthurClient } from "./index";
import { createPreviewClient } from "./preview-client";
import type { Invoke } from "./tauri-ipc";

const androidEnv = { isTauri: true, tauriPlatform: "android" };
const desktopEnv = { isTauri: true, tauriPlatform: "linux" };

const O = "11111111-1111-4111-8111-111111111111";
const r = (id: string, origin: string, parents: string[], extra: Record<string, unknown> = {}) => ({
  id,
  objectId: O,
  kind: "idea",
  title: "T",
  body: "B",
  createdAt: "2026-10-04T10:00:00Z",
  origin,
  parentRevisionIds: parents,
  ...extra,
});
const R1 = r("r1", "initial", [], { provenance: { captureId: "c1", sourceStart: 0, sourceEnd: 3 } });
const R2 = r("r2", "user_edit", ["r1"]);
const lineage = { objectId: O, currentRevisionId: "r2", revisions: [R1, R2] };
const diff = { oldRevisionId: "r1", newRevisionId: "r2", kind: { changed: false, from: "idea", to: "idea" }, title: { changed: false, segments: [{ op: "equal", text: "T" }] }, body: { changed: false, segments: [{ op: "equal", text: "B" }] } };

describe("lineage over IPC", () => {
  it.each([
    ["mobile", androidEnv],
    ["desktop", desktopEnv],
  ] as const)("the %s client calls the native commands with exactly the documented arguments", async (_kind, env) => {
    const call = vi.fn<Invoke>().mockImplementation((command) => {
      if (command === "get_object_lineage") return Promise.resolve(lineage);
      if (command === "diff_revisions") return Promise.resolve(diff);
      if (["list_revisions", "get_revision_parents", "get_revision_children"].includes(command)) return Promise.resolve([R1]);
      return Promise.resolve(R2);
    });
    const client = createArthurClient(env, call);

    await client.getObjectLineage(O);
    await client.listRevisions(O);
    await client.getRevision("r2");
    await client.getRevisionParents("r2");
    await client.getRevisionChildren("r1");
    // Extra fields a caller might try to smuggle in (id, timestamp, origin, provenance) never reach the native layer.
    await client.updateKnowledgeObject(O, { title: "x", id: "evil", origin: "merge", provenance: { captureId: "c" } } as never);
    await client.createRevisionFrom({ objectId: O, parentRevisionId: "r1", changes: { body: "b" }, makeCurrent: true });
    await client.createRevisionFrom({ objectId: O, parentRevisionId: "r1", changes: { kind: "task" } });
    await client.mergeRevisions({ objectId: O, parentRevisionIds: ["r2", "r3"], result: { kind: "idea", title: "t", body: "b", id: "evil" } as never, makeCurrent: false });
    await client.diffRevisions("r1", "r2");

    expect(call.mock.calls).toEqual([
      ["get_object_lineage", { objectId: O }],
      ["list_revisions", { objectId: O }],
      ["get_revision", { revisionId: "r2" }],
      ["get_revision_parents", { revisionId: "r2" }],
      ["get_revision_children", { revisionId: "r1" }],
      ["update_knowledge_object", { objectId: O, changes: { title: "x" } }],
      ["create_revision_from", { input: { objectId: O, parentRevisionId: "r1", changes: { body: "b" }, makeCurrent: true } }],
      ["create_revision_from", { input: { objectId: O, parentRevisionId: "r1", changes: { kind: "task" } } }],
      ["merge_revisions", { input: { objectId: O, parentRevisionIds: ["r2", "r3"], result: { kind: "idea", title: "t", body: "b" }, makeCurrent: false } }],
      ["diff_revisions", { oldRevisionId: "r1", newRevisionId: "r2" }],
    ]);
  });

  it("rejects obviously bad input before calling the native layer", async () => {
    const call = vi.fn<Invoke>();
    const client = createArthurClient(androidEnv, call);
    await expect(client.getObjectLineage("")).rejects.toThrow("Invalid object id");
    await expect(client.getRevision("")).rejects.toThrow("Invalid revision id");
    await expect(client.diffRevisions("r1", "")).rejects.toThrow("Invalid revision id");
    await expect(client.mergeRevisions({ objectId: O, parentRevisionIds: ["r1"], result: { kind: "idea", title: "t", body: "b" } })).rejects.toMatchObject({ name: "LineageError", code: "invalid_revision" });
    await expect(client.mergeRevisions({ objectId: O, parentRevisionIds: [], result: { kind: "idea", title: "t", body: "b" } })).rejects.toBeInstanceOf(LineageError);
    await expect(client.updateKnowledgeObject(O, null as never)).rejects.toMatchObject({ code: "invalid_revision" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["object_not_found", "That knowledge object no longer exists."],
    ["revision_not_found", "That revision no longer exists."],
    ["invalid_revision", "That revision is not valid: nothing changed."],
    ["storage_failed", "The history could not be read or saved: x"],
  ] as const)("turns the native %s rejection into a typed LineageError", async (code, message) => {
    const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockRejectedValue({ code, message }));
    for (const attempt of [
      () => client.getObjectLineage(O),
      () => client.updateKnowledgeObject(O, { title: "x" }),
      () => client.createRevisionFrom({ objectId: O, parentRevisionId: "r1", changes: { title: "x" } }),
      () => client.mergeRevisions({ objectId: O, parentRevisionIds: ["a", "b"], result: { kind: "idea", title: "t", body: "b" } }),
      () => client.diffRevisions("a", "b"),
    ]) {
      const failure = await attempt().then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(LineageError);
      expect(failure).toMatchObject({ code, message });
    }
  });

  it("passes unrecognised native failures through unchanged", async () => {
    await expect(createArthurClient(androidEnv, vi.fn<Invoke>().mockRejectedValue("boom")).getRevision("r1")).rejects.toBe("boom");
  });

  it("fails safely on malformed native responses, including DAG-shape violations", async () => {
    const badRevisions = [
      null,
      {},
      r("r2", "user_edit", []), // an edit needs exactly one parent
      r("r4", "merge", ["r2"]), // a merge needs two or more
      r("r1", "initial", ["r0"]), // an initial revision has no parent
      r("r2", "user_edit", ["r2"]), // self parent
      r("r2", "user_edit", ["r1"], { kind: "gizmo" }),
    ];
    for (const bad of badRevisions) {
      const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad));
      await expect(client.getRevision("r1")).rejects.toThrow("invalid revision");
      await expect(client.updateKnowledgeObject(O, { title: "x" })).rejects.toThrow("invalid revision");
    }
    for (const bad of [null, {}, [{}], [R1, { nope: true }], [r("r2", "user_edit", [])]]) {
      const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad));
      await expect(client.listRevisions(O)).rejects.toThrow("invalid revisions");
      await expect(client.getRevisionChildren("r1")).rejects.toThrow("invalid revisions");
    }
    for (const bad of [null, {}, { ...lineage, currentRevisionId: "zzz" }, { ...lineage, revisions: [R2, R1] }, { ...lineage, revisions: [] }]) {
      await expect(createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad)).getObjectLineage(O)).rejects.toThrow("invalid lineage");
    }
    for (const bad of [null, {}, { ...diff, body: { changed: true, segments: [{ op: "move", text: "x" }] } }]) {
      await expect(createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad)).diffRevisions("r1", "r2")).rejects.toThrow("invalid diff");
    }
  });
});

describe("preview client lineage", () => {
  const TEXT = "Arthur should organize my ideas automatically.";

  async function setup() {
    let n = 0;
    const client = createPreviewClient({ newId: () => `id-${++n}`, now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, n)) });
    const capture = await client.createCapture({ source: "text", content: TEXT });
    const [object] = (await client.distillCapture(capture.id)) as [KnowledgeObject];
    const lineage = await client.getObjectLineage(object.id);
    return { client, capture, object, r1: lineage.revisions[0] as ThoughtRevision };
  }

  it("gives every distilled object exactly one initial revision that keeps the original source span", async () => {
    const { client, capture, object, r1 } = await setup();
    const lineage = await client.getObjectLineage(object.id);
    expect(lineage.revisions).toHaveLength(1);
    expect(lineage.currentRevisionId).toBe(r1.id);
    expect(r1).toMatchObject({ origin: "initial", parentRevisionIds: [], title: object.title, body: object.body, kind: object.kind });
    expect(r1.provenance).toEqual({ captureId: capture.id, sourceStart: object.provenance.sourceStart, sourceEnd: object.provenance.sourceEnd });
  });

  it("an edit creates a new current revision whose parent is the previous one, and the object follows", async () => {
    const { client, object, r1 } = await setup();
    const r2 = await client.updateKnowledgeObject(object.id, { body: `${TEXT} And connect related ideas.` });

    expect(r2).toMatchObject({ origin: "user_edit", parentRevisionIds: [r1.id] });
    expect(r2.provenance).toBeUndefined();
    expect((await client.getObjectLineage(object.id)).currentRevisionId).toBe(r2.id);
    expect(await client.getRevision(r1.id)).toEqual(r1);
    expect((await client.listKnowledgeObjects())[0]?.body).toBe(r2.body);
    expect((await client.listKnowledgeObjects())[0]?.provenance).toEqual(object.provenance);
  });

  it("rejects no-op and invalid edits without writing anything", async () => {
    const { client, object, r1 } = await setup();
    for (const changes of [{}, { title: object.title }, { kind: object.kind, title: object.title, body: object.body }, { title: "  " }, { body: "" }, { kind: "gizmo" }, { title: "x", id: "evil" }, { title: "t".repeat(201) }]) {
      await expect(client.updateKnowledgeObject(object.id, changes as never)).rejects.toMatchObject({ name: "LineageError", code: "invalid_revision" });
    }
    await expect(client.updateKnowledgeObject("ghost", { title: "x" })).rejects.toMatchObject({ code: "object_not_found" });
    expect((await client.getObjectLineage(object.id)).revisions).toEqual([r1]);
  });

  it("branches from an old revision without becoming current or erasing the other continuation", async () => {
    const { client, object, r1 } = await setup();
    const r2 = await client.updateKnowledgeObject(object.id, { body: "Edited" });
    const r3 = await client.createRevisionFrom({ objectId: object.id, parentRevisionId: r1.id, changes: { body: "Branched" } });

    expect(r3.parentRevisionIds).toEqual([r1.id]);
    const lineage = await client.getObjectLineage(object.id);
    expect(lineage.currentRevisionId).toBe(r2.id);
    expect(lineage.revisions.map((x) => x.id)).toEqual([r1.id, r2.id, r3.id]);
    expect((await client.getRevisionChildren(r1.id)).map((x) => x.id)).toEqual([r2.id, r3.id]);
    expect((await client.listKnowledgeObjects())[0]?.body).toBe("Edited");
    const asCurrent = await client.createRevisionFrom({ objectId: object.id, parentRevisionId: r1.id, changes: { title: "New" }, makeCurrent: true });
    expect((await client.getObjectLineage(object.id)).currentRevisionId).toBe(asCurrent.id);
    expect((await client.listKnowledgeObjects())[0]?.title).toBe("New");
  });

  it("merges two or more revisions into one with all of them as parents, current only on request", async () => {
    const { client, object, r1 } = await setup();
    const r2 = await client.updateKnowledgeObject(object.id, { body: "Edited" });
    const r3 = await client.createRevisionFrom({ objectId: object.id, parentRevisionId: r1.id, changes: { body: "Branched" } });
    const result = { kind: object.kind, title: "Merged", body: "Both ideas combined." };

    const r4 = await client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r3.id, r2.id], result });

    expect(r4).toMatchObject({ origin: "merge", parentRevisionIds: [r2.id, r3.id] });
    expect(r4.provenance).toBeUndefined();
    expect((await client.getObjectLineage(object.id)).currentRevisionId).toBe(r2.id);
    const current = await client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r1.id, r2.id, r3.id], result: { ...result, body: "Three way." }, makeCurrent: true });
    expect(current.parentRevisionIds).toHaveLength(3);
    expect((await client.getObjectLineage(object.id)).currentRevisionId).toBe(current.id);
    expect((await client.getRevisionParents(r4.id)).map((x) => x.id)).toEqual([r2.id, r3.id]);
  });

  it("rejects bad parents everywhere: foreign object, unknown revision, too few, duplicates, too many", async () => {
    const { client, capture, object, r1 } = await setup();
    const other = await client.createCapture({ source: "text", content: "A second thought entirely" });
    const [otherObject] = (await client.distillCapture(other.id)) as [KnowledgeObject];
    const foreign = (await client.getObjectLineage(otherObject.id)).revisions[0] as ThoughtRevision;
    const r2 = await client.updateKnowledgeObject(object.id, { body: "Edited" });
    const result = { kind: object.kind, title: "t", body: "b" };

    await expect(client.createRevisionFrom({ objectId: object.id, parentRevisionId: foreign.id, changes: { body: "x" } })).rejects.toMatchObject({ code: "invalid_revision" });
    await expect(client.createRevisionFrom({ objectId: object.id, parentRevisionId: "ghost", changes: { body: "x" } })).rejects.toMatchObject({ code: "revision_not_found" });
    await expect(client.createRevisionFrom({ objectId: "ghost", parentRevisionId: r1.id, changes: { body: "x" } })).rejects.toMatchObject({ code: "object_not_found" });
    await expect(client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r1.id, foreign.id], result })).rejects.toMatchObject({ code: "invalid_revision" });
    await expect(client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r1.id, "ghost"], result })).rejects.toMatchObject({ code: "revision_not_found" });
    await expect(client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r1.id], result })).rejects.toMatchObject({ code: "invalid_revision" });
    await expect(client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r2.id, r2.id], result })).rejects.toMatchObject({ code: "invalid_revision" });
    const many = [r1.id, r2.id];
    for (let index = 0; many.length <= MAX_MERGE_PARENTS; index += 1) {
      many.push((await client.createRevisionFrom({ objectId: object.id, parentRevisionId: r1.id, changes: { body: `branch ${index}` } })).id);
    }
    await expect(client.mergeRevisions({ objectId: object.id, parentRevisionIds: many, result })).rejects.toMatchObject({ code: "invalid_revision" });
    for (const bad of [{ ...result, kind: "gizmo" }, { ...result, title: " " }, { ...result, body: "" }]) {
      await expect(client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r1.id, r2.id], result: bad as never })).rejects.toMatchObject({ code: "invalid_revision" });
    }
    expect((await client.getObjectLineage(object.id)).revisions).toHaveLength(2 + MAX_MERGE_PARENTS - 1);
    void capture;
  });

  it("diffs revisions deterministically and only within one object", async () => {
    const { client, object, r1 } = await setup();
    const r2 = await client.updateKnowledgeObject(object.id, { title: "New title", body: `${TEXT.slice(0, -1)} and connect related ideas.`, kind: "decision" });

    const first = await client.diffRevisions(r1.id, r2.id);

    expect(first).toEqual(await client.diffRevisions(r1.id, r2.id));
    expect(first.kind).toEqual({ changed: true, from: object.kind, to: "decision" });
    expect(first.title.changed && first.body.changed).toBe(true);
    expect(first.body.segments.filter((s) => s.op === "insert").map((s) => s.text).join("")).toBe(" and connect related ideas");
    expect((await client.diffRevisions(r1.id, r1.id)).body.changed).toBe(false);
    const other = await client.createCapture({ source: "text", content: "Another thought" });
    const [otherObject] = (await client.distillCapture(other.id)) as [KnowledgeObject];
    const foreign = (await client.getObjectLineage(otherObject.id)).revisions[0] as ThoughtRevision;
    await expect(client.diffRevisions(r1.id, foreign.id)).rejects.toMatchObject({ code: "invalid_revision" });
    await expect(client.diffRevisions(r1.id, "ghost")).rejects.toMatchObject({ code: "revision_not_found" });
  });

  it("leaves graph relations untouched by edits, branches and merges", async () => {
    const { client, object, r1 } = await setup();
    const other = await client.createCapture({ source: "text", content: "A related thought" });
    const [otherObject] = (await client.distillCapture(other.id)) as [KnowledgeObject];
    const edge = await client.createRelation({ kind: "supersedes", sourceObjectId: otherObject.id, targetObjectId: object.id });
    const before = await client.listRelations();

    const r2 = await client.updateKnowledgeObject(object.id, { body: "Edited" });
    const r3 = await client.createRevisionFrom({ objectId: object.id, parentRevisionId: r1.id, changes: { body: "Branched" } });
    await client.mergeRevisions({ objectId: object.id, parentRevisionIds: [r2.id, r3.id], result: { kind: "idea", title: "M", body: "Merged" }, makeCurrent: true });

    expect(await client.listRelations()).toEqual(before);
    expect(before).toContainEqual(edge);
    expect((await client.getObjectLineage(otherObject.id)).revisions).toHaveLength(1);
    expect((await client.getObjectRelations(object.id)).map((x) => x.id)).toEqual([edge.id]);
  });

  it("answers unknown ids with typed errors", async () => {
    const { client } = await setup();
    await expect(client.getObjectLineage("ghost")).rejects.toMatchObject({ code: "object_not_found" });
    await expect(client.listRevisions("ghost")).rejects.toMatchObject({ code: "object_not_found" });
    await expect(client.getRevision("ghost")).rejects.toMatchObject({ code: "revision_not_found" });
    await expect(client.getRevisionParents("ghost")).rejects.toMatchObject({ code: "revision_not_found" });
    await expect(client.getRevisionChildren("ghost")).rejects.toMatchObject({ code: "revision_not_found" });
  });
});
