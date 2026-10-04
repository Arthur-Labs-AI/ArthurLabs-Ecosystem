import { describe, expect, it } from "vitest";
import type { ThoughtRevision } from "@arthur/contracts";
import { layoutLineage } from "./lineage-layout";

const rev = (id: string, origin: ThoughtRevision["origin"], parents: string[]): ThoughtRevision => ({
  id,
  objectId: "o",
  kind: "idea",
  title: "t",
  body: "b",
  createdAt: "2026-10-04T10:00:00Z",
  origin,
  parentRevisionIds: parents,
});

describe("layoutLineage", () => {
  const diamond = [rev("r1", "initial", []), rev("r2", "user_edit", ["r1"]), rev("r3", "user_edit", ["r1"]), rev("r4", "merge", ["r2", "r3"])];

  it("puts a parent left of its children and a merge right of everything it merges", () => {
    const layout = layoutLineage(diamond);
    const x = (id: string) => layout.nodes.get(id)?.x ?? NaN;
    expect(x("r1")).toBeLessThan(x("r2"));
    expect(x("r2")).toBe(x("r3"));
    expect(x("r3")).toBeLessThan(x("r4"));
    expect(layout.nodes.get("r2")?.y).not.toBe(layout.nodes.get("r3")?.y);
    expect([...layout.nodes.values()].map((n) => n.label)).toEqual(["R1", "R2", "R3", "R4"]);
  });

  it("draws one arrow per parent link: two into the merge, two out of the branch point", () => {
    const layout = layoutLineage(diamond);
    expect(layout.edges.map((e) => e.id).sort()).toEqual(["r1>r2", "r1>r3", "r2>r4", "r3>r4"]);
    expect(layout.edges.filter((e) => e.childId === "r4")).toHaveLength(2);
    expect(layout.edges.filter((e) => e.parentId === "r1")).toHaveLength(2);
  });

  it("is deterministic, handles one revision, and sizes the canvas to the history", () => {
    expect(layoutLineage(diamond)).toEqual(layoutLineage(diamond));
    const single = layoutLineage([rev("r1", "initial", [])]);
    expect(single.nodes.size).toBe(1);
    expect(single.edges).toEqual([]);
    expect(layoutLineage(diamond).width).toBeGreaterThan(single.width);
    const chain = layoutLineage([rev("a", "initial", []), rev("b", "user_edit", ["a"]), rev("c", "user_edit", ["b"])]);
    expect(chain.nodes.get("c")?.generation).toBe(2);
  });

  it("puts a merge in the generation after its LATEST parent", () => {
    const layout = layoutLineage([rev("a", "initial", []), rev("b", "user_edit", ["a"]), rev("c", "user_edit", ["b"]), rev("d", "user_edit", ["a"]), rev("m", "merge", ["c", "d"])]);
    expect(layout.nodes.get("m")?.generation).toBe(3);
  });
});
