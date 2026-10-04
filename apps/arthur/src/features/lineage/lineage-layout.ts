import type { ThoughtRevision } from "@arthur/contracts";

/**
 * A deterministic layered layout of one object's revision DAG: columns are generations (the longest path from the
 * initial revision), so a parent is always to the left of its children, and a merge sits to the right of everything
 * it merges. No dependencies, no physics.
 */

export const REVISION_RADIUS = 18;
const COLUMN_WIDTH = 120;
const ROW_HEIGHT = 64;
const MARGIN_X = 40;
const MARGIN_Y = 36;

export interface LaidOutRevision {
  id: string;
  /** "R1", "R2", ... in order of creation. A display name only; the id is the identity. */
  label: string;
  x: number;
  y: number;
  generation: number;
}

export interface LaidOutParentEdge {
  /** `${parent}>${child}` */
  id: string;
  parentId: string;
  childId: string;
  path: string;
}

export interface LineageLayout {
  width: number;
  height: number;
  nodes: Map<string, LaidOutRevision>;
  edges: LaidOutParentEdge[];
}

/** Revisions must be oldest first (parents before children), as `ObjectLineage` guarantees. */
export function layoutLineage(revisions: readonly ThoughtRevision[]): LineageLayout {
  const generation = new Map<string, number>();
  for (const revision of revisions) {
    const parents = revision.parentRevisionIds.map((id) => generation.get(id) ?? 0);
    generation.set(revision.id, parents.length === 0 ? 0 : Math.max(...parents) + 1);
  }
  const rows = new Map<number, number>();
  const nodes = new Map<string, LaidOutRevision>();
  revisions.forEach((revision, index) => {
    const column = generation.get(revision.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    nodes.set(revision.id, { id: revision.id, label: `R${index + 1}`, x: MARGIN_X + column * COLUMN_WIDTH, y: MARGIN_Y + row * ROW_HEIGHT, generation: column });
  });

  const edges: LaidOutParentEdge[] = [];
  for (const revision of revisions) {
    const child = nodes.get(revision.id);
    for (const parentId of revision.parentRevisionIds) {
      const parent = nodes.get(parentId);
      if (!parent || !child) continue;
      const dx = child.x - parent.x;
      const dy = child.y - parent.y;
      const length = Math.hypot(dx, dy) || 1;
      const start = { x: parent.x + (dx / length) * REVISION_RADIUS, y: parent.y + (dy / length) * REVISION_RADIUS };
      const end = { x: child.x - (dx / length) * (REVISION_RADIUS + 4), y: child.y - (dy / length) * (REVISION_RADIUS + 4) };
      edges.push({ id: `${parentId}>${revision.id}`, parentId, childId: revision.id, path: `M ${Math.round(start.x)} ${Math.round(start.y)} L ${Math.round(end.x)} ${Math.round(end.y)}` });
    }
  }
  const columns = Math.max(0, ...generation.values()) + 1;
  const tallest = Math.max(1, ...rows.values());
  return { width: MARGIN_X * 2 + (columns - 1) * COLUMN_WIDTH, height: MARGIN_Y * 2 + (tallest - 1) * ROW_HEIGHT, nodes, edges };
}
