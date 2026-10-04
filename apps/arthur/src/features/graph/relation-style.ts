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
  model: "Proposed by the model",
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
