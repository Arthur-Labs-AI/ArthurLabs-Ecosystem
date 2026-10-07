import { describe, expect, it, vi } from "vitest";
import { INBOX_PROJECT_ID, isCognitiveAnswer, type CognitiveAnswer } from "@arthur/contracts";
import { RecallError } from "./arthur-client";
import { createPreviewClient } from "./preview-client";
import { askOverIpc, getSemanticRecallStatusOverIpc, purgeSemanticIndexOverIpc, setSemanticRecallEnabledOverIpc, type Invoke } from "./tauri-ipc";

function answer(overrides: Partial<CognitiveAnswer> = {}): CognitiveAnswer {
  return {
    query: "what does capture-first mobile depend on",
    scope: { projectId: "p1", projectName: "Arthur", archived: false },
    outcome: "answered",
    answer: { paragraphs: [{ text: "It depends on the microphone permission.", basedOn: ["E1", "E2"], temporal: "current" }], gaps: [] },
    evidence: [
      {
        handle: "E1",
        role: "primary",
        objectId: "o1",
        projectId: "p1",
        projectName: "Arthur",
        externalProject: false,
        kind: "idea",
        title: "Capture-first mobile",
        currentBody: "Open straight into capture.",
        currentRevisionId: "r1",
        status: "current",
        strength: { points: 4, level: "strong", sufficient: true, signals: [{ name: "lexical", points: 2 }] },
        retrieval: null,
        graph: null,
        lineage: { revisionCount: 2, entries: [] },
        provenance: { origin: null, currentRevisionSource: null, editedSinceCapture: false, currentRevisionOrigin: "initial" },
        cited: true,
        inContext: true,
      },
      {
        handle: "E2",
        role: "graph",
        objectId: "o2",
        projectId: "p2",
        projectName: "Wearable",
        externalProject: true,
        kind: "decision",
        title: "Microphone permission",
        currentBody: "Ask on first use.",
        currentRevisionId: "r2",
        status: "current",
        strength: { points: 2, level: "supporting", sufficient: false, signals: [] },
        retrieval: null,
        graph: { role: "expanded", score: 0.48, intentRelevant: true, paths: [{ fromObjectId: "o1", fromHandle: "E1", toObjectId: "o2", relationId: "rel1", relationKind: "depends_on", direction: "out", distance: 1, externalProject: true }], supersededBy: [], supersedes: [], conflictsWith: [], contradictory: false, aliases: [] },
        lineage: null,
        provenance: null,
        cited: true,
        inContext: true,
      },
    ],
    diagnostics: {
      retrieval: { intent: {}, lexical: "ok", semantic: "disabled", semanticReason: null, semanticCoverage: null, embeddingRequests: 0, uploadedTexts: 0, sqlReads: 2 },
      enrichment: {},
      context: null,
      synthesis: { state: "ok", reason: null, model: "m", retried: false, requests: 1, strippedRefs: 0, droppedParagraphs: 0, temporalCorrected: 0 },
      timings: {},
      counts: {},
      sqlReads: 6,
    },
    ...overrides,
  };
}

describe("ask over IPC", () => {
  it("passes the question and the EXPLICIT scope through untouched, and returns a valid answer", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(answer());
    const result = await askOverIpc({ query: "  what does it depend on  ", scope: { projectId: "p1" } }, call);
    expect(result.outcome).toBe("answered");
    expect(call).toHaveBeenCalledWith("ask", { query: { query: "  what does it depend on  ", scope: { projectId: "p1" } } });
    // nothing else (no active project, no extra fields) is sent
    expect(Object.keys((call.mock.calls[0]?.[1] as { query: object }).query).sort()).toEqual(["query", "scope"]);
  });

  it("rejects a bad question locally with a RecallError and never calls the native layer", async () => {
    const call = vi.fn<Invoke>();
    for (const bad of [{ query: "", scope: { projectId: "p" } }, { query: "x".repeat(501), scope: { projectId: "p" } }, { query: "x", scope: { projectId: "" } }, { query: "x" } as never]) {
      await expect(askOverIpc(bad, call)).rejects.toMatchObject({ code: "invalid_query" });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("maps native error payloads to RecallError and refuses an untrustworthy payload", async () => {
    const rejecting = (payload: unknown): Invoke => () => Promise.reject(payload);
    await expect(askOverIpc({ query: "x", scope: { projectId: "p" } }, rejecting({ code: "project_not_found", message: "no" }))).rejects.toBeInstanceOf(RecallError);
    await expect(askOverIpc({ query: "x", scope: { projectId: "p" } }, rejecting({ code: "project_not_found", message: "no" }))).rejects.toMatchObject({ code: "project_not_found" });
    await expect(askOverIpc({ query: "x", scope: { projectId: "p" } }, rejecting(new Error("boom")))).rejects.toThrow("boom");
    for (const bad of [null, {}, { ...answer(), outcome: "chatty" }, { ...answer(), evidence: [{ handle: "E1" }] }, { ...answer(), outcome: "retrieval_only" }, { ...answer(), answer: { paragraphs: [{ text: "x", basedOn: ["E1"], temporal: "sometimes" }], gaps: [] } }]) {
      await expect(askOverIpc({ query: "x", scope: { projectId: "p" } }, () => Promise.resolve(bad))).rejects.toThrow("invalid answer");
    }
  });

  it("accepts the three outcomes and the degraded shapes", () => {
    expect(isCognitiveAnswer(answer({ outcome: "insufficient_evidence", answer: null, evidence: [] }))).toBe(true);
    expect(isCognitiveAnswer(answer({ outcome: "retrieval_only", answer: null }))).toBe(true);
    expect(isCognitiveAnswer(answer({ outcome: "retrieval_only" }))).toBe(false);
  });
});

describe("ask in the preview client", () => {
  it("validates like the native layer and never invents an answer or evidence", async () => {
    const client = createPreviewClient();
    const result = await client.ask({ query: "anything", scope: { projectId: INBOX_PROJECT_ID } });
    expect(isCognitiveAnswer(result)).toBe(true);
    expect([result.outcome, result.answer, result.evidence]).toEqual(["insufficient_evidence", null, []]);
    await expect(client.ask({ query: "x", scope: { projectId: "missing" } })).rejects.toMatchObject({ code: "project_not_found" });
    await expect(client.ask({ query: " ", scope: { projectId: INBOX_PROJECT_ID } })).rejects.toMatchObject({ code: "invalid_query" });
  });
});

describe("semantic Recall over IPC", () => {
  const status = { enabled: true, savedEnabled: true, savedModelKey: "m:1", settingsCorrupt: false, activeModelKey: "m:1", storedVectors: 3, storedVectorsAllKeys: 3, pendingObjects: 1 };

  it("calls the native commands by name with only what each needs", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(status);
    expect(await getSemanticRecallStatusOverIpc(call)).toEqual(status);
    await setSemanticRecallEnabledOverIpc(true, call);
    await setSemanticRecallEnabledOverIpc(false, call);
    await purgeSemanticIndexOverIpc(call);
    expect(call.mock.calls).toEqual([["get_semantic_recall_status", {}], ["set_semantic_recall_enabled", { enabled: true }], ["set_semantic_recall_enabled", { enabled: false }], ["purge_semantic_index", {}]]);
  });

  it("rejects a status that is not the contract and maps a native failure to a RecallError", async () => {
    await expect(getSemanticRecallStatusOverIpc(() => Promise.resolve({ enabled: "yes" }))).rejects.toThrow(/invalid semantic Recall status/);
    const failure = { code: "storage_failed", message: "the preference could not be saved" };
    await expect(setSemanticRecallEnabledOverIpc(true, () => Promise.reject(failure))).rejects.toMatchObject({ name: "RecallError", code: "storage_failed" });
    await expect(purgeSemanticIndexOverIpc(() => Promise.reject(failure))).rejects.toBeInstanceOf(RecallError);
  });

  it("the preview is OFF by default, remembers the choice, keeps vectors when turned off, and purges only on request", async () => {
    const client = createPreviewClient({ recall: { semantic: { storedVectors: 5, storedVectorsAllKeys: 5 } } });
    expect((await client.getSemanticRecallStatus()).enabled).toBe(false);
    expect((await client.setSemanticRecallEnabled(true)).enabled).toBe(true);
    const off = await client.setSemanticRecallEnabled(false);
    expect(off).toMatchObject({ enabled: false, savedEnabled: false, storedVectors: 5 });
    expect(await client.purgeSemanticIndex()).toMatchObject({ storedVectors: 0, storedVectorsAllKeys: 0 });
  });
});
