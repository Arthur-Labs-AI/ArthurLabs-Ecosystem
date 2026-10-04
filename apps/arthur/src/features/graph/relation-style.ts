import { isSymmetricRelationKind, type CognitiveRelation, type CognitiveRelationKind, type CognitiveRelationOrigin } from "@arthur/contracts";

/** Short, human wording for each kind (used in text, so meaning never depends on colour alone). */
export const RELATION_LABELS: Record<CognitiveRelationKind, string> = {
  related_to: "related to",
  extends: "extends",
  depends_on: "depends on",
  contradicts: "contradicts",
  derived_from: "derived from",
  duplicates: "duplicates",
  supersedes: "supersedes",
};

/** What the kind means, shown next to the manual-creation form. */
export const RELATION_MEANINGS: Record<CognitiveRelationKind, string> = {
  related_to: "A general semantic link. No direction.",
  extends: "The first develops or adds detail to the second.",
  depends_on: "The first needs the second to work, be valid or make sense.",
  contradicts: "The two materially conflict. No direction.",
  derived_from: "The first was derived from the knowledge in the second.",
  duplicates: "The two say effectively the same thing. No direction.",
  supersedes: "The first replaces the second as the current knowledge.",
};

export const ORIGIN_LABELS: Record<CognitiveRelationOrigin, string> = {
  model: "Proposed by Arthur",
  user: "Created by you",
  system: "Created by Arthur",
};

export function isDirectional(relation: Pick<CognitiveRelation, "kind">): boolean {
  return !isSymmetricRelationKind(relation.kind);
}

/** "A extends B" for a directional edge, "A related to B" (either order) for a symmetric one. */
export function describeRelation(relation: CognitiveRelation, titleOf: (objectId: string) => string): string {
  return `${titleOf(relation.sourceObjectId)} ${RELATION_LABELS[relation.kind]} ${titleOf(relation.targetObjectId)}`;
}

/** How a directional relation reads from its target's side: "A extends B" is "B, extended by A". */
export const INVERSE_LABELS: Record<CognitiveRelationKind, string> = {
  related_to: "related to",
  extends: "extended by",
  depends_on: "needed by",
  contradicts: "contradicts",
  derived_from: "source of",
  duplicates: "duplicates",
  supersedes: "superseded by",
};

/** The wording of a relation as seen from `viewpointId`. Symmetric kinds read the same from both ends. */
export function relationVerbFrom(relation: Pick<CognitiveRelation, "kind" | "sourceObjectId">, viewpointId: string): string {
  return relation.sourceObjectId === viewpointId ? RELATION_LABELS[relation.kind] : INVERSE_LABELS[relation.kind];
}

export type ArrowStyle = "chevron" | "triangle" | "hollow" | "stop" | "bars" | null;

/**
 * Edge geometry encodes the relation kind; colour only reinforces it. The same table draws the graph edges and the
 * legend/inspector swatches, so they can never disagree.
 */
export const RELATION_GEOMETRY: Record<CognitiveRelationKind, { width: number; dash: string; round?: boolean; arrow: ArrowStyle; double?: boolean }> = {
  related_to: { width: 1.3, dash: "", arrow: null },
  extends: { width: 1.6, dash: "", arrow: "chevron" },
  depends_on: { width: 1.6, dash: "7 5", arrow: "triangle" },
  derived_from: { width: 1.7, dash: "1.5 5", round: true, arrow: "hollow" },
  contradicts: { width: 1.8, dash: "", arrow: "bars" },
  duplicates: { width: 4.2, dash: "", arrow: null, double: true },
  supersedes: { width: 1.7, dash: "", arrow: "stop" },
};
