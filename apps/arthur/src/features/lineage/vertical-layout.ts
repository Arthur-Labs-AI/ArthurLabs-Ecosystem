import type { ThoughtRevision } from "@arthur/contracts";

/**
 * A deterministic top-to-bottom layout of one object's revision DAG, for a narrow screen.
 *
 * Rows are revisions in the order the lineage gives them (oldest first, parents before children), so time runs down
 * the page. Lanes run across it. A revision continues its first parent's lane when it is that parent's first child;
 * any other child (a branch) takes the lowest lane that is free from its parent's row on. A lane stays reserved from
 * a revision down to the last row that still draws a line out of it, so lines never run through another revision.
 * It only arranges; it never changes what the lineage says.
 */

export type EdgeKind = "straight" | "branch" | "merge";

export interface VerticalRevision {
  id: string;
  /** "R1", "R2", ... in order of creation. */
  label: string;
  row: number;
  lane: number;
}

export interface VerticalEdge {
  parentId: string;
  childId: string;
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
  /** straight: one lane. branch: leaves its parent into a new lane. merge: a later parent joins the child's lane. */
  kind: EdgeKind;
}

export interface VerticalLayout {
  lanes: number;
  revisions: VerticalRevision[];
  edges: VerticalEdge[];
  /** Children beyond the first, summed over every revision. */
  branches: number;
  merges: number;
}

export function layoutVerticalLineage(revisions: readonly ThoughtRevision[]): VerticalLayout {
  const row = new Map<string, number>();
  const children = new Map<string, string[]>();
  revisions.forEach((revision, index) => {
    row.set(revision.id, index);
    for (const parentId of revision.parentRevisionIds) children.set(parentId, [...(children.get(parentId) ?? []), revision.id]);
  });

  const lane = new Map<string, number>();
  const reservedUntil: number[] = [];
  revisions.forEach((revision, index) => {
    const first = revision.parentRevisionIds[0];
    let chosen: number | null = null;
    if (first !== undefined && children.get(first)?.[0] === revision.id) chosen = lane.get(first) ?? 0;
    if (chosen === null) {
      const from = first !== undefined ? (row.get(first) ?? index) : index;
      chosen = 0;
      while (reservedUntil[chosen] !== undefined && (reservedUntil[chosen] as number) >= from) chosen += 1;
    }
    lane.set(revision.id, chosen);
    reservedUntil[chosen] = Math.max(reservedUntil[chosen] ?? -1, index);
    for (const parentId of revision.parentRevisionIds) {
      const parentLane = lane.get(parentId) ?? 0;
      reservedUntil[parentLane] = Math.max(reservedUntil[parentLane] ?? -1, index);
    }
  });

  const edges: VerticalEdge[] = [];
  for (const revision of revisions) {
    revision.parentRevisionIds.forEach((parentId, position) => {
      const fromLane = lane.get(parentId);
      const toLane = lane.get(revision.id);
      const fromRow = row.get(parentId);
      const toRow = row.get(revision.id);
      if (fromLane === undefined || toLane === undefined || fromRow === undefined || toRow === undefined) return;
      edges.push({ parentId, childId: revision.id, fromRow, toRow, fromLane, toLane, kind: fromLane === toLane ? "straight" : position === 0 ? "branch" : "merge" });
    });
  }

  return {
    lanes: Math.max(0, ...lane.values()) + 1,
    revisions: revisions.map((revision, index) => ({ id: revision.id, label: `R${index + 1}`, row: index, lane: lane.get(revision.id) ?? 0 })),
    edges,
    branches: [...children.values()].reduce((sum, kids) => sum + Math.max(0, kids.length - 1), 0),
    merges: revisions.filter((revision) => revision.parentRevisionIds.length > 1).length,
  };
}
