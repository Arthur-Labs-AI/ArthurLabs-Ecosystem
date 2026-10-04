import type { CognitiveRelation, KnowledgeObject } from "@arthur/contracts";

/**
 * A deterministic circular layout. Same objects and relations in, same picture out, so the graph
 * looks identical after a restart. No physics, no dependencies: this milestone is not a graph editor.
 */

export const NODE_RADIUS = 16;
const LABEL_MARGIN = 190;
const VERTICAL_MARGIN = 70;
const PAIR_SPACING = 38;

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  /** Where the label sits, and which way it extends from that point. */
  labelX: number;
  labelY: number;
  anchor: "start" | "middle" | "end";
}

export interface LaidOutEdge {
  id: string;
  /** SVG path from the edge of the source node to the edge of the target node. */
  path: string;
  labelX: number;
  labelY: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: Map<string, LaidOutNode>;
  edges: LaidOutEdge[];
}

const round = (value: number): number => Math.round(value * 10) / 10;

function unit(dx: number, dy: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

export function layoutGraph(objects: readonly KnowledgeObject[], relations: readonly CognitiveRelation[]): GraphLayout {
  const count = objects.length;
  const ring = count <= 1 ? 0 : Math.max(110, (count * 52) / (2 * Math.PI));
  const width = round(2 * (ring + LABEL_MARGIN));
  const height = round(2 * (ring + VERTICAL_MARGIN));
  const cx = width / 2;
  const cy = height / 2;

  const nodes = new Map<string, LaidOutNode>();
  objects.forEach((object, index) => {
    const angle = count <= 1 ? Math.PI / 2 : -Math.PI / 2 + (2 * Math.PI * index) / count;
    const x = cx + ring * Math.cos(angle);
    const y = cy + ring * Math.sin(angle);
    const outward = NODE_RADIUS + 8;
    const horizontal = Math.cos(angle);
    nodes.set(object.id, {
      id: object.id,
      x: round(x),
      y: round(y),
      labelX: round(x + outward * horizontal),
      labelY: round(y + (outward + 6) * Math.sin(angle) + 4),
      anchor: horizontal > 0.3 ? "start" : horizontal < -0.3 ? "end" : "middle",
    });
  });

  // Several edges can join the same two objects (different kinds, or opposite directions): fan them out.
  const groups = new Map<string, CognitiveRelation[]>();
  for (const relation of relations) {
    const key = [relation.sourceObjectId, relation.targetObjectId].sort().join("|");
    groups.set(key, [...(groups.get(key) ?? []), relation]);
  }

  const edges: LaidOutEdge[] = [];
  for (const group of groups.values()) {
    group.forEach((relation, index) => {
      const source = nodes.get(relation.sourceObjectId);
      const target = nodes.get(relation.targetObjectId);
      if (!source || !target) return; // the store never returns a dangling edge; never draw one either
      // Bend relative to a fixed orientation of the pair, so opposite edges fan out on different sides.
      const [first, second] = source.id < target.id ? [source, target] : [target, source];
      const along = unit(second.x - first.x, second.y - first.y);
      const offset = (index - (group.length - 1) / 2) * PAIR_SPACING;
      const control = { x: (source.x + target.x) / 2 - along.y * offset * 2, y: (source.y + target.y) / 2 + along.x * offset * 2 };

      const fromSource = unit(control.x - source.x, control.y - source.y);
      const fromTarget = unit(control.x - target.x, control.y - target.y);
      const start = { x: source.x + fromSource.x * NODE_RADIUS, y: source.y + fromSource.y * NODE_RADIUS };
      const end = { x: target.x + fromTarget.x * (NODE_RADIUS + 3), y: target.y + fromTarget.y * (NODE_RADIUS + 3) };

      edges.push({
        id: relation.id,
        path: `M ${round(start.x)} ${round(start.y)} Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`,
        labelX: round(0.25 * start.x + 0.5 * control.x + 0.25 * end.x),
        labelY: round(0.25 * start.y + 0.5 * control.y + 0.25 * end.y),
      });
    });
  }
  return { width, height, nodes, edges };
}
