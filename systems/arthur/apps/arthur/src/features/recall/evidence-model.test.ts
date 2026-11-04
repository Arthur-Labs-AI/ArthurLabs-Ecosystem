import { describe, expect, it } from "vitest";
import { actionsFor, includedBecause, indexEvidence, markersFor, orderEvidence, parseHandle, synthesisReason } from "./evidence-model";
import { answer, evidence, paragraph, richAnswer } from "../../test/recall-fixtures";

describe("evidence model", () => {
  it("parses entry and history handles", () => {
    expect(parseHandle("E3")).toEqual({ entry: "E3", history: false });
    expect(parseHandle("E3.h2")).toEqual({ entry: "E3", history: true });
  });

  it("never shows a marker for a handle the evidence does not contain", () => {
    const result = answer({ evidence: [evidence({ handle: "E1" })] });
    const index = indexEvidence(result.evidence);
    expect(markersFor(paragraph("x", ["E1", "E9", "E1.h1", "E1"]), index).map((m) => m.handle)).toEqual(["E1"]);
  });

  it("orders cited evidence by first citation, then the rest", () => {
    const { cited, other } = orderEvidence(richAnswer());
    expect(cited.map((e) => e.handle)).toEqual(["E1", "E3", "E2"]);
    expect(other.map((e) => e.handle)).toEqual(["E4"]);
  });

  it("states graph reasons as sentences, from either end of the relation", () => {
    const e1 = evidence({ handle: "E1", title: "Arthur Mobile" });
    const e2 = evidence({ handle: "E2", title: "Temporary audio retry", role: "graph", graph: { role: "expanded", score: 1, intentRelevant: true, paths: [{ fromObjectId: "a", fromHandle: "E1", toObjectId: "b", relationId: "r", relationKind: "depends_on", direction: "out", distance: 1, externalProject: false }], supersededBy: [], supersedes: [], conflictsWith: [], contradictory: false, aliases: [] } });
    const index = indexEvidence([e1, e2]);
    expect(includedBecause(e2, index)).toEqual(["Arthur Mobile depends on Temporary audio retry"]);
    const inbound = { ...e2, graph: { ...e2.graph!, paths: [{ ...e2.graph!.paths[0]!, direction: "in" as const }] } };
    expect(includedBecause(inbound, index)).toEqual(["Temporary audio retry depends on Arthur Mobile"]);
  });

  it("offers an action only when it exists", () => {
    expect(actionsFor(evidence({ provenance: null }))).toEqual({ idea: true, capture: false, evolution: false, connections: false, project: false });
    expect(actionsFor(richAnswer().evidence[2]!).project).toBe(true);
  });

  it("explains a missing written answer without exposing anything stored", () => {
    const base = answer();
    for (const state of ["unavailable", "failed", "invalidOutput"] as const) {
      const reason = synthesisReason({ ...base, diagnostics: { ...base.diagnostics, synthesis: { ...base.diagnostics.synthesis, state } } });
      expect(reason).toMatch(/\.$/);
    }
    expect(synthesisReason(base)).toBeNull();
  });
});
