import { describe, expect, it, vi } from "vitest";
import { MAX_INFERENCE_CANDIDATES, MAX_RELATIONS_PER_INFERENCE, RELATION_KINDS, SYMMETRIC_RELATION_KINDS, type KnowledgeObject } from "@arthur/contracts";
import { RelationError } from "./arthur-client";
import { createArthurClient } from "./index";
import { createPreviewClient, type PreviewClientOptions, type PreviewRelationProposal } from "./preview-client";
import type { Invoke } from "./tauri-ipc";

const androidEnv = { isTauri: true, tauriPlatform: "android" };
const desktopEnv = { isTauri: true, tauriPlatform: "linux" };

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const relation = { id: "r-1", kind: "extends", sourceObjectId: B, targetObjectId: A, createdAt: "2026-10-04T12:00:00Z", origin: "user" };
const object = {
  id: A,
  kind: "idea",
  title: "t",
  body: "b",
  createdAt: "2026-10-04T12:00:00Z",
  provenance: { captureId: "c1", sourceStart: 0, sourceEnd: 1 },
  projectId: "00000000-0000-4000-8000-000000000001",
};

describe("relations over IPC", () => {
  it.each([
    ["mobile", androidEnv],
    ["desktop", desktopEnv],
  ] as const)("the %s client sends only the contract fields to the native commands", async (_kind, env) => {
    const call = vi.fn<Invoke>().mockResolvedValue(relation);
    const client = createArthurClient(env, call);

    // Extra fields a caller might try to smuggle in (id, timestamp, origin) never reach the native layer.
    const input = { kind: "extends", sourceObjectId: B, targetObjectId: A, id: "evil", createdAt: "x", origin: "model" } as never;
    await expect(client.createRelation(input)).resolves.toEqual(relation);

    expect(call).toHaveBeenCalledExactlyOnceWith("create_relation", { input: { kind: "extends", sourceObjectId: B, targetObjectId: A } });
  });

  it("calls the list, query and inference commands with exactly the documented arguments", async () => {
    const call = vi.fn<Invoke>().mockImplementation((command) => Promise.resolve(command === "get_object_neighbors" ? [object] : [relation]));
    const client = createArthurClient(androidEnv, call);

    await client.listRelations();
    await client.getObjectRelations(A);
    await client.getObjectRelations(A, { direction: "incoming", kind: "extends" });
    await client.getObjectNeighbors(A, { direction: "outgoing" });
    await client.inferRelations();
    await client.inferRelations([A, B]);

    expect(call.mock.calls).toEqual([
      ["list_relations", undefined],
      ["get_object_relations", { objectId: A }],
      ["get_object_relations", { objectId: A, direction: "incoming", kind: "extends" }],
      ["get_object_neighbors", { objectId: A, direction: "outgoing" }],
      ["infer_relations", undefined],
      ["infer_relations", { objectIds: [A, B] }],
    ]);
  });

  it("rejects a malformed relation before calling the native layer", async () => {
    const call = vi.fn<Invoke>();
    const client = createArthurClient(androidEnv, call);
    for (const input of [
      { kind: "friends_with", sourceObjectId: A, targetObjectId: B },
      { kind: "extends", sourceObjectId: A, targetObjectId: A },
      { kind: "extends", sourceObjectId: "", targetObjectId: B },
    ]) {
      await expect(client.createRelation(input as never)).rejects.toMatchObject({ name: "RelationError", code: "invalid_relation" });
    }
    await expect(client.getObjectRelations("")).rejects.toThrow("Invalid object id");
    await expect(client.inferRelations([""])).rejects.toThrow("Invalid object ids");
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["object_not_found", "One of those knowledge objects no longer exists."],
    ["invalid_relation", "That relation is not valid: x."],
    ["llm_failed", "Could not reach the language model."],
    ["llm_invalid_output", "The language model returned something that could not be trusted."],
    ["llm_not_configured", "The language model is not configured on this device."],
    ["storage_failed", "The result could not be saved: x"],
  ] as const)("turns the native %s rejection into a typed RelationError", async (code, message) => {
    const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockRejectedValue({ code, message }));
    for (const attempt of [
      () => client.createRelation({ kind: "extends", sourceObjectId: A, targetObjectId: B }),
      () => client.listRelations(),
      () => client.getObjectRelations(A),
      () => client.getObjectNeighbors(A),
      () => client.inferRelations(),
    ]) {
      const failure = await attempt().then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RelationError);
      expect(failure).toMatchObject({ code, message });
    }
  });

  it("passes unrecognised native failures through unchanged", async () => {
    await expect(createArthurClient(androidEnv, vi.fn<Invoke>().mockRejectedValue("boom")).listRelations()).rejects.toBe("boom");
  });

  it("fails safely on malformed native responses, including a dangling-looking or non-canonical edge", async () => {
    const malformed = [
      null,
      {},
      "x",
      [{}],
      [{ ...relation, kind: "friends_with" }],
      [{ ...relation, origin: "robot" }],
      [{ ...relation, targetObjectId: relation.sourceObjectId }],
      [{ ...relation, kind: "related_to" }], // symmetric but not in canonical order
      [{ ...relation, id: "" }],
      [relation, { nope: true }],
    ];
    for (const bad of malformed) {
      const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad));
      await expect(client.listRelations()).rejects.toThrow("invalid relations");
      await expect(client.getObjectRelations(A)).rejects.toThrow("invalid relations");
      await expect(client.inferRelations()).rejects.toThrow("invalid relations");
      if (!Array.isArray(bad)) await expect(client.createRelation({ kind: "extends", sourceObjectId: A, targetObjectId: B })).rejects.toThrow("invalid relation");
      await expect(client.getObjectNeighbors(A)).rejects.toThrow("invalid knowledge objects");
    }
  });
});

describe("preview client graph", () => {
  /** Distils `count` captures into one object each and returns the objects, oldest first. */
  async function withObjects(count: number, options: PreviewClientOptions = {}) {
    let n = 0;
    const client = createPreviewClient({ newId: () => `id-${String(++n).padStart(4, "0")}`, now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, n % 60)), ...options });
    const objects: KnowledgeObject[] = [];
    for (let index = 0; index < count; index += 1) {
      const capture = await client.createCapture({ source: "text", content: `thought number ${index}` });
      objects.push(...(await client.distillCapture(capture.id)));
    }
    return { client, objects };
  }

  it("creates a relation of every kind with a generated id, time and user origin", async () => {
    const { client, objects } = await withObjects(2);
    for (const kind of RELATION_KINDS) {
      const created = await client.createRelation({ kind, sourceObjectId: objects[0]!.id, targetObjectId: objects[1]!.id });
      expect(created).toMatchObject({ kind, origin: "user" });
      expect(created.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    }
    expect(await client.listRelations()).toHaveLength(7);
  });

  it("rejects invalid kinds, self relations and missing objects, storing nothing", async () => {
    const { client, objects } = await withObjects(2);
    const [a, b] = objects as [KnowledgeObject, KnowledgeObject];
    await expect(client.createRelation({ kind: "nope" as never, sourceObjectId: a.id, targetObjectId: b.id })).rejects.toMatchObject({ code: "invalid_relation" });
    await expect(client.createRelation({ kind: "extends", sourceObjectId: a.id, targetObjectId: a.id })).rejects.toMatchObject({ code: "invalid_relation" });
    await expect(client.createRelation({ kind: "extends", sourceObjectId: "ghost", targetObjectId: b.id })).rejects.toMatchObject({ code: "object_not_found" });
    await expect(client.createRelation({ kind: "extends", sourceObjectId: a.id, targetObjectId: "ghost" })).rejects.toMatchObject({ code: "object_not_found" });
    expect(await client.listRelations()).toEqual([]);
  });

  it("creating the same edge twice returns the first; symmetric edges are canonical either way round", async () => {
    const { client, objects } = await withObjects(2);
    const [a, b] = objects as [KnowledgeObject, KnowledgeObject];
    const first = await client.createRelation({ kind: "depends_on", sourceObjectId: a.id, targetObjectId: b.id });
    expect(await client.createRelation({ kind: "depends_on", sourceObjectId: a.id, targetObjectId: b.id })).toEqual(first);
    // Directional: the opposite direction is a different edge.
    const opposite = await client.createRelation({ kind: "depends_on", sourceObjectId: b.id, targetObjectId: a.id });
    expect(opposite.id).not.toBe(first.id);
    expect(first).toMatchObject({ sourceObjectId: a.id, targetObjectId: b.id });
    expect(opposite).toMatchObject({ sourceObjectId: b.id, targetObjectId: a.id });

    for (const kind of SYMMETRIC_RELATION_KINDS) {
      const forward = await client.createRelation({ kind, sourceObjectId: a.id, targetObjectId: b.id });
      const backward = await client.createRelation({ kind, sourceObjectId: b.id, targetObjectId: a.id });
      expect(backward).toEqual(forward);
      expect(forward.sourceObjectId < forward.targetObjectId).toBe(true);
    }
    expect(await client.listRelations()).toHaveLength(2 + SYMMETRIC_RELATION_KINDS.length);
  });

  it("answers incoming, outgoing, neighbour and kind-filtered queries; a symmetric edge is both ways", async () => {
    const { client, objects } = await withObjects(4);
    const [a, b, c, d] = objects as [KnowledgeObject, KnowledgeObject, KnowledgeObject, KnowledgeObject];
    await client.createRelation({ kind: "extends", sourceObjectId: a.id, targetObjectId: b.id });
    await client.createRelation({ kind: "depends_on", sourceObjectId: c.id, targetObjectId: a.id });
    await client.createRelation({ kind: "related_to", sourceObjectId: a.id, targetObjectId: d.id });
    const kinds = async (id: string, filter?: Parameters<typeof client.getObjectRelations>[1]) => (await client.getObjectRelations(id, filter)).map((r) => r.kind);

    expect(await kinds(a.id, { direction: "outgoing" })).toEqual(["extends", "related_to"]);
    expect(await kinds(a.id, { direction: "incoming" })).toEqual(["depends_on", "related_to"]);
    expect(await kinds(a.id)).toEqual(["extends", "depends_on", "related_to"]);
    expect(await kinds(b.id, { direction: "outgoing" })).toEqual([]);
    expect(await kinds(d.id, { direction: "outgoing" })).toEqual(["related_to"]);
    expect(await kinds(a.id, { kind: "depends_on" })).toEqual(["depends_on"]);

    const titles = async (id: string, filter?: Parameters<typeof client.getObjectNeighbors>[1]) => (await client.getObjectNeighbors(id, filter)).map((o) => o.id);
    expect((await titles(a.id)).sort()).toEqual([b.id, c.id, d.id].sort());
    expect(await titles(a.id, { direction: "outgoing", kind: "extends" })).toEqual([b.id]);
    expect(await titles(b.id, { direction: "outgoing" })).toEqual([]);

    await expect(client.getObjectRelations("ghost")).rejects.toMatchObject({ code: "object_not_found" });
    await expect(client.getObjectRelations(a.id, { kind: "nope" as never })).rejects.toMatchObject({ code: "invalid_relation" });
  });

  const propose = (kind: string, from: KnowledgeObject, to: KnowledgeObject): PreviewRelationProposal => ({ kind, sourceObjectId: from.id, targetObjectId: to.id });

  it("infers a relation through deterministic validation, marking it as model-made", async () => {
    let proposals: PreviewRelationProposal[] = [];
    const { client, objects } = await withObjects(3, { inference: { proposals: () => proposals } });
    proposals = [propose("extends", objects[1]!, objects[0]!), propose("depends_on", objects[1]!, objects[2]!)];

    const added = await client.inferRelations();

    expect(added.map((r) => [r.kind, r.sourceObjectId, r.targetObjectId, r.origin])).toEqual([
      ["extends", objects[1]!.id, objects[0]!.id, "model"],
      ["depends_on", objects[1]!.id, objects[2]!.id, "model"],
    ]);
    expect(await client.listRelations()).toEqual(added);
  });

  it("zero relations is a valid inference result", async () => {
    const { client } = await withObjects(3);
    expect(await client.inferRelations()).toEqual([]);
    expect(await client.listRelations()).toEqual([]);
  });

  it("rejects the whole set when any proposal is invalid, writing nothing", async () => {
    let bad: PreviewRelationProposal = propose("extends", {} as KnowledgeObject, {} as KnowledgeObject);
    let objects: KnowledgeObject[] = [];
    const made = await withObjects(3, { inference: { proposals: () => [propose("extends", objects[1]!, objects[0]!), bad] } });
    objects = made.objects;
    const [a, b] = objects as [KnowledgeObject, KnowledgeObject];

    for (const candidate of [
      { kind: "extends", sourceObjectId: "hallucinated", targetObjectId: a.id },
      { kind: "friends_with", sourceObjectId: a.id, targetObjectId: b.id },
      { kind: "extends", sourceObjectId: a.id, targetObjectId: a.id },
      propose("extends", b, a), // duplicate of the first proposal
    ]) {
      bad = candidate;
      await expect(made.client.inferRelations()).rejects.toMatchObject({ code: "llm_invalid_output" });
      expect(await made.client.listRelations()).toEqual([]);
    }
  });

  it("running inference twice does not duplicate edges, and a manual edge keeps its origin", async () => {
    let objects: KnowledgeObject[] = [];
    const made = await withObjects(2, { inference: { proposals: () => [propose("extends", objects[1]!, objects[0]!), propose("related_to", objects[0]!, objects[1]!)] } });
    objects = made.objects;
    const manual = await made.client.createRelation({ kind: "extends", sourceObjectId: objects[1]!.id, targetObjectId: objects[0]!.id });

    const first = await made.client.inferRelations();
    const second = await made.client.inferRelations();

    expect(first.map((r) => r.kind)).toEqual(["related_to"]);
    expect(second).toEqual([]);
    const all = await made.client.listRelations();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(manual);
    expect(all.map((r) => r.origin)).toEqual(["user", "model"]);
  });

  it("limits the candidate set to the most recent objects, and never accepts one outside it", async () => {
    let seen: KnowledgeObject[] = [];
    let objects: KnowledgeObject[] = [];
    const made = await withObjects(MAX_INFERENCE_CANDIDATES + 3, {
      inference: {
        proposals: (candidates) => {
          seen = candidates;
          return [propose("related_to", objects[MAX_INFERENCE_CANDIDATES + 2]!, objects[0]!)];
        },
      },
    });
    objects = made.objects;

    await expect(made.client.inferRelations()).rejects.toMatchObject({ code: "llm_invalid_output" });

    expect(seen).toHaveLength(MAX_INFERENCE_CANDIDATES);
    expect(seen.map((o) => o.id)).not.toContain(objects[0]!.id);
    // Asking about the oldest object pulls it into the set (and pushes out another).
    await expect(made.client.inferRelations([objects[0]!.id])).resolves.toHaveLength(1);
    expect(seen.map((o) => o.id)).toContain(objects[0]!.id);
    expect(seen).toHaveLength(MAX_INFERENCE_CANDIDATES);
    await expect(made.client.inferRelations(["ghost"])).rejects.toMatchObject({ code: "object_not_found" });
  });

  it("rejects an oversized proposal set and reports a provider failure that can be retried", async () => {
    let objects: KnowledgeObject[] = [];
    const made = await withObjects(2, {
      inference: { proposals: () => Array.from({ length: MAX_RELATIONS_PER_INFERENCE + 1 }, () => propose("extends", objects[0]!, objects[1]!)) },
    });
    objects = made.objects;
    await expect(made.client.inferRelations()).rejects.toMatchObject({ code: "llm_invalid_output" });

    const flaky = await withObjects(2, { inference: { error: new RelationError("llm_failed", "offline"), once: true } });
    await expect(flaky.client.inferRelations()).rejects.toMatchObject({ code: "llm_failed" });
    await expect(flaky.client.inferRelations()).resolves.toEqual([]);
  });

  it("with fewer than two objects there is nothing to relate", async () => {
    const { client } = await withObjects(1);
    expect(await client.inferRelations()).toEqual([]);
  });
});

describe("graph-changed events", () => {
  it("subscribes to the native event, forwards it, and unsubscribes (even if it was cancelled before the subscription resolved)", async () => {
    const { onGraphIntegratedOverIpc, GRAPH_INTEGRATED_EVENT } = await import("./tauri-ipc");
    let handler: (() => void) | undefined;
    const stop = vi.fn();
    const subscribe = vi.fn(async (event: string, h: () => void) => {
      handler = h;
      expect(event).toBe(GRAPH_INTEGRATED_EVENT);
      return stop;
    });
    const listener = vi.fn();
    const unsubscribe = onGraphIntegratedOverIpc(listener, subscribe);
    await Promise.resolve();
    handler?.();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);

    const early = onGraphIntegratedOverIpc(listener, subscribe);
    early();
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("never throws where there is no native event bus", () => {
    const subscribe = () => {
      throw new Error("no bus");
    };
    return import("./tauri-ipc").then(({ onGraphIntegratedOverIpc }) => {
      const unsubscribe = onGraphIntegratedOverIpc(() => {}, subscribe as never);
      expect(() => unsubscribe()).not.toThrow();
    });
  });
});
