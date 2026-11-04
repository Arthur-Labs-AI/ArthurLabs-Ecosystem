import type { ThoughtRevision } from "@arthur/contracts";
import { describe, expect, it } from "vitest";
import { layoutVerticalLineage } from "./vertical-layout";

const rev = (id: string, parents: string[], origin: ThoughtRevision["origin"] = parents.length === 0 ? "initial" : parents.length > 1 ? "merge" : "user_edit"): ThoughtRevision => ({
  id,
  objectId: "o",
  kind: "idea",
  title: id,
  body: id,
  createdAt: "2026-10-01T10:00:00Z",
  origin,
  parentRevisionIds: parents,
});

describe("layoutVerticalLineage", () => {
  it("puts a straight history in one lane, oldest at the top", () => {
    const layout = layoutVerticalLineage([rev("a", []), rev("b", ["a"]), rev("c", ["b"])]);
    expect(layout.lanes).toBe(1);
    expect(layout.revisions.map((r) => [r.label, r.row, r.lane])).toEqual([["R1", 0, 0], ["R2", 1, 0], ["R3", 2, 0]]);
    expect(layout.edges.every((edge) => edge.kind === "straight")).toBe(true);
    expect([layout.branches, layout.merges]).toEqual([0, 0]);
  });

  it("gives a branch its own lane and brings it back with a merge", () => {
    const layout = layoutVerticalLineage([rev("r1", []), rev("r2", ["r1"]), rev("r3", ["r1"], "distillation"), rev("r4", ["r2", "r3"])]);
    const lane = (id: string) => layout.revisions.find((r) => r.id === id)?.lane;
    expect([lane("r1"), lane("r2"), lane("r3"), lane("r4")]).toEqual([0, 0, 1, 0]);
    expect(layout.lanes).toBe(2);
    const kind = (parent: string, child: string) => layout.edges.find((edge) => edge.parentId === parent && edge.childId === child)?.kind;
    expect([kind("r1", "r2"), kind("r1", "r3"), kind("r2", "r4"), kind("r3", "r4")]).toEqual(["straight", "branch", "straight", "merge"]);
    expect([layout.branches, layout.merges]).toEqual([1, 1]);
  });

  it("keeps three lines apart through a three-parent merge, and never reuses a lane that still has a line in it", () => {
    const layout = layoutVerticalLineage([rev("r1", []), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r1"]), rev("r5", ["r2", "r3", "r4"])]);
    expect(layout.lanes).toBe(3);
    expect(new Set(layout.revisions.slice(1, 4).map((r) => r.lane)).size).toBe(3);
    expect(layout.revisions[4]?.lane).toBe(0);
    expect(layout.merges).toBe(1);
    expect(layout.branches).toBe(2);
  });

  it("is deterministic: the same lineage gives the same picture", () => {
    const history = [rev("r1", []), rev("r2", ["r1"]), rev("r3", ["r1"]), rev("r4", ["r2", "r3"])];
    expect(layoutVerticalLineage(history)).toEqual(layoutVerticalLineage(history));
  });

  it("handles an empty history", () => {
    const layout = layoutVerticalLineage([]);
    expect(layout.revisions).toEqual([]);
    expect(layout.lanes).toBe(1);
  });
});
