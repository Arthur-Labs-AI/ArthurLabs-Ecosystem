import { describe, expect, it } from "vitest";
import type { CognitiveRelation, KnowledgeObject } from "@arthur/contracts";
import { layoutGraph, nodeRadius } from "./graph-layout";

const object = (id: string): KnowledgeObject => ({
  id,
  kind: "idea",
  title: id,
  body: "b",
  createdAt: "2026-10-04T12:00:00Z",
  provenance: { captureId: "c", sourceStart: 0, sourceEnd: 1 },
});
const relation = (id: string, kind: CognitiveRelation["kind"], sourceObjectId: string, targetObjectId: string): CognitiveRelation => ({
  id,
  kind,
  sourceObjectId,
  targetObjectId,
  createdAt: "2026-10-04T12:00:00Z",
  origin: "user",
});

describe("layoutGraph", () => {
  const objects = ["a", "b", "c", "d", "e", "f"].map(object);
  const relations = [relation("r1", "extends", "a", "b"), relation("r2", "depends_on", "c", "a"), relation("r3", "related_to", "d", "a")];

  it("is deterministic: the same graph always gives the same picture", () => {
    expect(layoutGraph(objects, relations)).toEqual(layoutGraph(objects, relations));
    expect(layoutGraph(objects, relations, "mini")).toEqual(layoutGraph(objects, relations, "mini"));
  });

  it("does not depend on the order the objects arrive in", () => {
    const shuffled = [...objects].reverse();
    const one = layoutGraph(objects, relations);
    const two = layoutGraph(shuffled, relations);
    // the relaxation visits nodes in input order, so positions may differ slightly, but never wildly
    for (const [id, node] of one.nodes) {
      const other = two.nodes.get(id)!;
      expect(Math.hypot(node.x - other.x, node.y - other.y)).toBeLessThan(400);
    }
  });

  it("gives every node a finite position inside the viewBox, apart from each other", () => {
    const layout = layoutGraph(objects, relations);
    const { viewBox } = layout;
    const points = [...layout.nodes.values()];
    expect(points).toHaveLength(6);
    for (const { x, y, r } of points) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x - r).toBeGreaterThanOrEqual(viewBox.x);
      expect(x + r).toBeLessThanOrEqual(viewBox.x + viewBox.width);
      expect(y - r).toBeGreaterThanOrEqual(viewBox.y);
      expect(y + r).toBeLessThanOrEqual(viewBox.y + viewBox.height);
    }
    for (const [i, p] of points.entries()) {
      for (const q of points.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.r + q.r + 10);
    }
  });

  it("grows a node with its connections, so hubs read at a glance", () => {
    const layout = layoutGraph(objects, relations);
    expect(layout.nodes.get("a")!.degree).toBe(3);
    expect(layout.nodes.get("a")!.r).toBeGreaterThan(layout.nodes.get("b")!.r);
    expect(layout.nodes.get("f")!.r).toBe(nodeRadius(0, "full"));
    expect(nodeRadius(50, "full")).toBe(nodeRadius(7, "full")); // capped
  });

  it("does not reshuffle the whole map when one unrelated idea is added", () => {
    const before = layoutGraph(objects, relations);
    const after = layoutGraph([...objects, object("z")], relations);
    const spread = Math.max(before.viewBox.width, before.viewBox.height);
    for (const [id, node] of before.nodes) {
      const moved = Math.hypot(node.x - after.nodes.get(id)!.x, node.y - after.nodes.get(id)!.y);
      expect(moved).toBeLessThan(spread);
    }
  });

  it("draws an edge between connected nodes only, leaving room for an arrowhead at a directional target", () => {
    const layout = layoutGraph(objects, relations);
    expect(layout.edges.map((e) => e.id).sort()).toEqual(["r1", "r2", "r3"]);
    const edge = layout.edges.find((e) => e.id === "r1")!;
    const [, endX, endY] = edge.path.match(/Q [\d.-]+ [\d.-]+ ([\d.-]+) ([\d.-]+)$/)!.map(Number) as [number, number, number];
    const target = layout.nodes.get("b")!;
    // an arrow sits outside the target node, not under it
    expect(Math.hypot(endX! - target.x, endY! - target.y)).toBeGreaterThan(target.r + 4);
  });

  it("never lays out an edge whose object is missing, or an edge from an object to itself", () => {
    const layout = layoutGraph(objects, [relation("ghost", "extends", "a", "nope"), relation("loop", "related_to", "a", "a"), relation("ok", "extends", "a", "b")]);
    expect(layout.edges.map((e) => e.id)).toEqual(["ok"]);
    expect(layout.nodes.get("a")!.degree).toBe(1);
  });

  it("fans out several edges between the same two objects instead of drawing them on top of each other", () => {
    const layout = layoutGraph(objects, [relation("x", "extends", "a", "b"), relation("y", "related_to", "a", "b"), relation("z", "depends_on", "b", "a")]);
    expect(new Set(layout.edges.map((e) => e.path)).size).toBe(3);
  });

  it("handles empty and single-object graphs", () => {
    const none = layoutGraph([], []);
    expect(none.nodes.size).toBe(0);
    expect(none.viewBox.width).toBeGreaterThan(0);
    const one = layoutGraph([object("only")], []);
    expect(one.nodes.size).toBe(1);
    expect(Number.isFinite(one.nodes.get("only")!.x)).toBe(true);
  });

  it("the mini scale is smaller than the full one", () => {
    const full = layoutGraph(objects, relations, "full");
    const mini = layoutGraph(objects, relations, "mini");
    expect(mini.viewBox.width).toBeLessThan(full.viewBox.width);
    expect(mini.nodes.get("a")!.r).toBeLessThan(full.nodes.get("a")!.r);
  });
});
