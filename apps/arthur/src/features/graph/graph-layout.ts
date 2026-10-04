import type { CognitiveRelation, KnowledgeObject } from "@arthur/contracts";
import { RELATION_GEOMETRY } from "./relation-style";

/**
 * A deterministic, organic layout of the knowledge graph. Same objects and relations in, same picture out, so the map
 * is the same map after a restart.
 *
 * Each node starts at a position derived from a hash of its OWN id (not its index), then a fixed number of
 * force-directed steps relax the picture. Because the start does not depend on the other nodes, adding one idea
 * moves its neighbourhood a little rather than reshuffling the whole map. There is no randomness and no animation.
 */

export type GraphScale = "full" | "mini";

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  /** Drawn radius. Grows with the number of connections, so hubs read at a glance. */
  r: number;
  degree: number;
}

export interface LaidOutEdge {
  id: string;
  /** SVG path from the edge of the source node to the edge of the target node, leaving room for an arrowhead. */
  path: string;
  /** The middle of the curve, where a label goes. */
  labelX: number;
  labelY: number;
}

export interface GraphLayout {
  /** viewBox of the whole picture, including room for labels. */
  viewBox: { x: number; y: number; width: number; height: number };
  nodes: Map<string, LaidOutNode>;
  edges: LaidOutEdge[];
}

const SCALES: Record<GraphScale, { base: number; perDegree: number; maxDegree: number; spacing: number; labelW: number; labelH: number }> = {
  full: { base: 14, perDegree: 2.4, maxDegree: 7, spacing: 160, labelW: 80, labelH: 64 },
  mini: { base: 8, perDegree: 1.1, maxDegree: 6, spacing: 100, labelW: 56, labelH: 28 },
};

const ITERATIONS = 280;

const round = (value: number): number => Math.round(value * 10) / 10;

/** FNV-1a, mapped to [0, 1). Stable across runs and platforms. */
function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

function unit(dx: number, dy: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

export function nodeRadius(degree: number, scale: GraphScale): number {
  const s = SCALES[scale];
  return s.base + Math.min(degree, s.maxDegree) * s.perDegree;
}

export function layoutGraph(objects: readonly KnowledgeObject[], relations: readonly CognitiveRelation[], scale: GraphScale = "full"): GraphLayout {
  const s = SCALES[scale];
  const known = new Set(objects.map((object) => object.id));
  // Never lay out (or draw) an edge whose object is missing, and never twice the same pair of ends for the same kind.
  const usable = relations.filter((relation) => known.has(relation.sourceObjectId) && known.has(relation.targetObjectId) && relation.sourceObjectId !== relation.targetObjectId);

  const degree = new Map<string, number>(objects.map((object) => [object.id, 0]));
  for (const relation of usable) {
    degree.set(relation.sourceObjectId, (degree.get(relation.sourceObjectId) ?? 0) + 1);
    degree.set(relation.targetObjectId, (degree.get(relation.targetObjectId) ?? 0) + 1);
  }

  const count = objects.length;
  const spread = s.spacing * Math.max(1, Math.sqrt(count)) * 0.9;
  const ids = objects.map((object) => object.id);
  const x = new Map<string, number>();
  const y = new Map<string, number>();
  for (const id of ids) {
    const angle = hash01(`${id}:angle`) * 2 * Math.PI;
    const radius = spread * (0.35 + 0.65 * Math.sqrt(hash01(`${id}:radius`)));
    x.set(id, Math.cos(angle) * radius);
    y.set(id, Math.sin(angle) * radius);
  }

  const k = s.spacing;
  const pairs = usable.map((relation) => [relation.sourceObjectId, relation.targetObjectId] as const);
  for (let step = 0; step < ITERATIONS && count > 1; step += 1) {
    const temperature = k * 0.6 * (1 - step / ITERATIONS) + 0.5;
    const dx = new Map<string, number>(ids.map((id) => [id, 0]));
    const dy = new Map<string, number>(ids.map((id) => [id, 0]));
    // repulsion between every pair
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        let ex = (x.get(a) as number) - (x.get(b) as number);
        let ey = (y.get(a) as number) - (y.get(b) as number);
        let d = Math.hypot(ex, ey);
        if (d < 0.01) {
          // exactly coincident: separate along a hash-derived direction (still deterministic)
          const angle = hash01(`${a}|${b}`) * 2 * Math.PI;
          ex = Math.cos(angle);
          ey = Math.sin(angle);
          d = 1;
        }
        const force = (k * k) / d;
        dx.set(a, (dx.get(a) as number) + (ex / d) * force);
        dy.set(a, (dy.get(a) as number) + (ey / d) * force);
        dx.set(b, (dx.get(b) as number) - (ex / d) * force);
        dy.set(b, (dy.get(b) as number) - (ey / d) * force);
      }
    }
    // attraction along edges
    for (const [a, b] of pairs) {
      const ex = (x.get(a) as number) - (x.get(b) as number);
      const ey = (y.get(a) as number) - (y.get(b) as number);
      const d = Math.hypot(ex, ey) || 0.01;
      const force = (d * d) / (k * 1.5);
      dx.set(a, (dx.get(a) as number) - (ex / d) * force);
      dy.set(a, (dy.get(a) as number) - (ey / d) * force);
      dx.set(b, (dx.get(b) as number) + (ex / d) * force);
      dy.set(b, (dy.get(b) as number) + (ey / d) * force);
    }
    // gentle gravity keeps separate components from drifting away
    for (const id of ids) {
      dx.set(id, (dx.get(id) as number) - (x.get(id) as number) * 0.9);
      dy.set(id, (dy.get(id) as number) - (y.get(id) as number) * 0.9);
    }
    for (const id of ids) {
      const mx = dx.get(id) as number;
      const my = dy.get(id) as number;
      const d = Math.hypot(mx, my) || 1;
      const move = Math.min(d, temperature);
      x.set(id, (x.get(id) as number) + (mx / d) * move);
      y.set(id, (y.get(id) as number) + (my / d) * move);
    }
  }

  // Labels are wider than they are tall, so open the picture up horizontally once it has settled.
  const stretch = scale === "full" ? 1.3 : 1.15;
  const nodes = new Map<string, LaidOutNode>();
  for (const id of ids) {
    const d = degree.get(id) ?? 0;
    nodes.set(id, { id, x: round((x.get(id) as number) * stretch), y: round(y.get(id) as number), r: nodeRadius(d, scale), degree: d });
  }

  // Several edges can join the same two objects (different kinds, or opposite directions): fan them out.
  const groups = new Map<string, CognitiveRelation[]>();
  for (const relation of usable) {
    const key = [relation.sourceObjectId, relation.targetObjectId].sort().join("|");
    groups.set(key, [...(groups.get(key) ?? []), relation]);
  }

  const edges: LaidOutEdge[] = [];
  for (const group of groups.values()) {
    group.forEach((relation, index) => {
      const source = nodes.get(relation.sourceObjectId) as LaidOutNode;
      const target = nodes.get(relation.targetObjectId) as LaidOutNode;
      const arrow = RELATION_GEOMETRY[relation.kind].arrow !== null;
      const length = Math.hypot(target.x - source.x, target.y - source.y) || 1;
      // Bend relative to a fixed orientation of the pair, so opposite edges fan out on different sides.
      const [first, second] = source.id < target.id ? [source, target] : [target, source];
      const along = unit(second.x - first.x, second.y - first.y);
      const lone = group.length === 1;
      const bend = lone ? (hash01(relation.id) < 0.5 ? -1 : 1) * Math.min(34, length * 0.1) : (index - (group.length - 1) / 2) * 34;
      const control = { x: (source.x + target.x) / 2 - along.y * bend * 2, y: (source.y + target.y) / 2 + along.x * bend * 2 };
      const fromSource = unit(control.x - source.x, control.y - source.y);
      const fromTarget = unit(control.x - target.x, control.y - target.y);
      const start = { x: source.x + fromSource.x * (source.r + 4), y: source.y + fromSource.y * (source.r + 4) };
      const end = { x: target.x + fromTarget.x * (target.r + (arrow ? 9 : 4)), y: target.y + fromTarget.y * (target.r + (arrow ? 9 : 4)) };
      edges.push({
        id: relation.id,
        path: `M ${round(start.x)} ${round(start.y)} Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`,
        labelX: round(0.25 * start.x + 0.5 * control.x + 0.25 * end.x),
        labelY: round(0.25 * start.y + 0.5 * control.y + 0.25 * end.y),
      });
    });
  }

  // viewBox: the bounding box of the nodes, plus room for their labels.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes.values()) {
    minX = Math.min(minX, node.x - Math.max(node.r, s.labelW));
    maxX = Math.max(maxX, node.x + Math.max(node.r, s.labelW));
    minY = Math.min(minY, node.y - node.r - 8);
    maxY = Math.max(maxY, node.y + node.r + s.labelH);
  }
  if (nodes.size === 0) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }
  const pad = scale === "full" ? 24 : 6;
  return {
    viewBox: { x: round(minX - pad), y: round(minY - pad), width: round(maxX - minX + 2 * pad), height: round(maxY - minY + 2 * pad) },
    nodes,
    edges,
  };
}
