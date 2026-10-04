import type { ThoughtRevision } from "@arthur/contracts";

/**
 * A deterministic left-to-right layout of one object's revision DAG, in lanes.
 *
 * Columns are generations (the longest path from the initial revision), so a parent is always to the left of its
 * children and a merge sits right of everything it merges. Lane 0 is the line of thought; a revision that continues
 * its first parent stays in that parent's lane, and any other child (a branch) takes the next free lane. No
 * dependencies, no physics.
 */

export const REVISION_WIDTH = 54;
export const REVISION_HEIGHT = 32;
const COLUMN_WIDTH = 152;
const LANE_HEIGHT = 118;
const MARGIN_X = 70;
const MARGIN_TOP = 44;
const MARGIN_BOTTOM = 64;
const CORNER = 14;

export interface LaidOutRevision {
  id: string;
  /** "R1", "R2", ... in order of creation. A display name only; the id is the identity. */
  label: string;
  /** Centre of the revision. */
  x: number;
  y: number;
  column: number;
  lane: number;
}

export interface LaidOutParentEdge {
  /** `${parent}>${child}` */
  id: string;
  parentId: string;
  childId: string;
  /** Right-angle rail with rounded corners, from the parent's right edge to the child's left edge. */
  path: string;
}

export interface LineageLayout {
  width: number;
  height: number;
  lanes: number;
  nodes: Map<string, LaidOutRevision>;
  edges: LaidOutParentEdge[];
}

/** Revisions must be oldest first (parents before children), as `ObjectLineage` guarantees. */
export function layoutLineage(revisions: readonly ThoughtRevision[]): LineageLayout {
  const column = new Map<string, number>();
  for (const revision of revisions) {
    const parents = revision.parentRevisionIds.map((id) => column.get(id) ?? 0);
    column.set(revision.id, parents.length === 0 ? 0 : Math.max(...parents) + 1);
  }

  const lane = new Map<string, number>();
  const occupied = new Set<string>();
  const continued = new Set<string>(); // parents whose first child has already taken their lane
  for (const revision of revisions) {
    const col = column.get(revision.id) ?? 0;
    const first = revision.parentRevisionIds[0];
    let chosen = 0;
    if (first !== undefined) {
      if (!continued.has(first)) {
        continued.add(first);
        chosen = lane.get(first) ?? 0;
      } else {
        chosen = 1; // a branch: the lowest free lane below the line of thought
      }
    }
    while (occupied.has(`${col}:${chosen}`)) chosen += 1;
    occupied.add(`${col}:${chosen}`);
    lane.set(revision.id, chosen);
  }

  const lanes = Math.max(0, ...lane.values()) + 1;
  const columns = Math.max(0, ...column.values()) + 1;
  const nodes = new Map<string, LaidOutRevision>();
  revisions.forEach((revision, index) => {
    const c = column.get(revision.id) ?? 0;
    const l = lane.get(revision.id) ?? 0;
    nodes.set(revision.id, { id: revision.id, label: `R${index + 1}`, x: MARGIN_X + c * COLUMN_WIDTH, y: MARGIN_TOP + REVISION_HEIGHT / 2 + l * LANE_HEIGHT, column: c, lane: l });
  });

  const edges: LaidOutParentEdge[] = [];
  for (const revision of revisions) {
    const child = nodes.get(revision.id);
    if (!child) continue;
    for (const parentId of revision.parentRevisionIds) {
      const parent = nodes.get(parentId);
      if (!parent) continue;
      const x1 = parent.x + REVISION_WIDTH / 2;
      const y1 = parent.y;
      const x2 = child.x - REVISION_WIDTH / 2;
      const y2 = child.y;
      let path: string;
      if (y1 === y2) {
        path = `M ${x1} ${y1} H ${x2 - 1}`;
      } else if (y2 > y1) {
        // branch: leave the parent, turn down early, run along the new lane
        const turn = x1 + 10 + CORNER;
        path = `M ${x1} ${y1} H ${x1 + 10} Q ${turn} ${y1} ${turn} ${y1 + CORNER} V ${y2 - CORNER} Q ${turn} ${y2} ${turn + CORNER} ${y2} H ${x2 - 1}`;
      } else {
        // merge: run along the branch lane, turn up just before the child
        const turn = x2 - 10 - CORNER;
        path = `M ${x1} ${y1} H ${turn - CORNER} Q ${turn} ${y1} ${turn} ${y1 - CORNER} V ${y2 + CORNER} Q ${turn} ${y2} ${turn + CORNER} ${y2} H ${x2 - 1}`;
      }
      edges.push({ id: `${parentId}>${revision.id}`, parentId, childId: revision.id, path });
    }
  }

  return {
    width: MARGIN_X * 2 + (columns - 1) * COLUMN_WIDTH,
    height: MARGIN_TOP + REVISION_HEIGHT + (lanes - 1) * LANE_HEIGHT + MARGIN_BOTTOM,
    lanes,
    nodes,
    edges,
  };
}
