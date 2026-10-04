import { describe, expect, it } from "vitest";
import type { ThoughtRevision } from "@arthur/contracts";
import { REVISION_WIDTH, layoutLineage } from "./lineage-layout";

const rev = (id: string, parents: string[] = [], origin: ThoughtRevision["origin"] = "user_edit"): ThoughtRevision => ({
  id,
  objectId: "o",
  kind: "idea",
  title: id,
  body: id,
  createdAt: "2026-10-04T12:00:00Z",
  origin,
  parentRevisionIds: parents,
});

describe("layoutLineage", () => {
  it("a straight history is one lane, one column per revision, left to right", () => {
    const layout = layoutLineage([rev("a", [], "initial"), rev("b", ["a"]), rev("c", ["b"])]);
    expect(layout.lanes).toBe(1);
    expect([...layout.nodes.values()].map((n) => [n.label, n.column, n.lane])).toEqual([["R1", 0, 0], ["R2", 1, 0], ["R3", 2, 0]]);
    const xs = [...layout.nodes.values()].map((n) => n.x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
  });

  it("a branch takes a second lane, and a merge returns to the line of thought", () => {
    // R1 -> R2 (edit), R1 -> R3 (branch), R2 + R3 -> R4 (merge), R4 -> R5
    const layout = layoutLineage([rev("r1", [], "initial"), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r2", "r3"], "merge"), rev("r5", ["r4"])]);
    const at = (id: string) => layout.nodes.get(id)!;
    expect(layout.lanes).toBe(2);
    expect([at("r1").lane, at("r2").lane, at("r3").lane, at("r4").lane, at("r5").lane]).toEqual([0, 0, 1, 0, 0]);
    // siblings share a column, the merge is right of both
    expect(at("r2").column).toBe(at("r3").column);
    expect(at("r4").column).toBe(at("r2").column + 1);
    expect(at("r5").column).toBe(at("r4").column + 1);
  });

  it("a parent is always strictly left of its child", () => {
    const revisions = [rev("r1", [], "initial"), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r2", "r3"], "merge"), rev("r5", ["r3"]), rev("r6", ["r4", "r5"], "merge")];
    const layout = layoutLineage(revisions);
    for (const edge of layout.edges) expect(layout.nodes.get(edge.parentId)!.x).toBeLessThan(layout.nodes.get(edge.childId)!.x);
  });

  it("never puts two revisions in the same cell", () => {
    const revisions = [rev("r1", [], "initial"), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r1"]), rev("r5", ["r1"])];
    const layout = layoutLineage(revisions);
    const cells = [...layout.nodes.values()].map((n) => `${n.column}:${n.lane}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(layout.lanes).toBe(4);
  });

  it("draws one right-angle rail per parent link, from the parent's right edge to the child's left edge", () => {
    const layout = layoutLineage([rev("r1", [], "initial"), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r2", "r3"], "merge")]);
    expect(layout.edges).toHaveLength(4);
    const straight = layout.edges.find((e) => e.id === "r1>r2")!;
    expect(straight.path).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+$/);
    const down = layout.edges.find((e) => e.id === "r1>r3")!;
    expect(down.path).toContain("V"); // turns down into the branch lane
    const up = layout.edges.find((e) => e.id === "r3>r4")!;
    expect(up.path).toContain("V"); // turns back up into the merge
    const start = Number(straight.path.split(" ")[1]);
    expect(start).toBe(layout.nodes.get("r1")!.x + REVISION_WIDTH / 2);
  });

  it("is deterministic and fits its content", () => {
    const revisions = [rev("r1", [], "initial"), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r2", "r3"], "merge")];
    expect(layoutLineage(revisions)).toEqual(layoutLineage(revisions));
    const layout = layoutLineage(revisions);
    for (const node of layout.nodes.values()) {
      expect(node.x + REVISION_WIDTH / 2).toBeLessThanOrEqual(layout.width);
      expect(node.y).toBeLessThan(layout.height);
    }
  });

  it("copes with no revisions and with an unknown parent", () => {
    expect(layoutLineage([]).nodes.size).toBe(0);
    expect(() => layoutLineage([rev("a", ["missing"])])).not.toThrow();
  });
});
