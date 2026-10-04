import { describe, expect, it } from "vitest";
import type { CognitiveRelation, KnowledgeObject } from "@arthur/contracts";
import { NODE_RADIUS, layoutGraph } from "./graph-layout";

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
  const objects = ["a", "b", "c", "d", "e"].map(object);

  it("is deterministic: the same graph always gives the same picture", () => {
    const relations = [relation("r1", "extends", "a", "b"), relation("r2", "depends_on", "c", "a")];
    expect(layoutGraph(objects, relations)).toEqual(layoutGraph(objects, relations));
  });

  it("places every node inside the canvas, apart from each other", () => {
    const layout = layoutGraph(objects, []);
    const points = [...layout.nodes.values()];
    expect(points).toHaveLength(5);
    for (const { x, y } of points) {
      expect(x).toBeGreaterThanOrEqual(NODE_RADIUS);
      expect(x).toBeLessThanOrEqual(layout.width - NODE_RADIUS);
      expect(y).toBeGreaterThanOrEqual(NODE_RADIUS);
      expect(y).toBeLessThanOrEqual(layout.height - NODE_RADIUS);
    }
    for (const [index, p] of points.entries()) {
      for (const q of points.slice(index + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(NODE_RADIUS * 2);
    }
  });

  it("handles zero and one object", () => {
    expect(layoutGraph([], []).nodes.size).toBe(0);
    const single = layoutGraph([object("a")], []);
    expect(single.nodes.get("a")).toMatchObject({ x: single.width / 2, y: single.height / 2 });
  });

  it("draws one path per edge and fans out several edges between the same two objects", () => {
    const layout = layoutGraph(objects, [relation("r1", "extends", "a", "b"), relation("r2", "related_to", "a", "b"), relation("r3", "depends_on", "b", "a")]);
    expect(layout.edges).toHaveLength(3);
    expect(new Set(layout.edges.map((edge) => edge.path)).size).toBe(3);
  });

  it("never draws an edge whose object is missing", () => {
    const layout = layoutGraph(objects, [relation("r1", "extends", "a", "ghost")]);
    expect(layout.edges).toEqual([]);
  });

  it("scales the canvas with the number of objects", () => {
    const many = Array.from({ length: 30 }, (_, index) => object(`n${index}`));
    expect(layoutGraph(many, []).width).toBeGreaterThan(layoutGraph(objects, []).width);
  });
});
