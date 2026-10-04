import { useMemo } from "react";
import type { CognitiveRelation } from "@arthur/contracts";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useGraphState } from "./graph-context";

export interface RelationIndex {
  /** Only relations whose two objects are both present, so a stale list can never show a dangling edge. */
  usable: CognitiveRelation[];
  edgesOf: (objectId: string) => CognitiveRelation[];
  countOf: (objectId: string) => number;
}

export function useRelationIndex(): RelationIndex {
  const { relations } = useGraphState();
  const { objects } = useKnowledge();
  return useMemo(() => {
    const present = new Set(objects.map((object) => object.id));
    const usable = relations.filter((relation) => present.has(relation.sourceObjectId) && present.has(relation.targetObjectId));
    const byObject = new Map<string, CognitiveRelation[]>();
    for (const relation of usable) {
      for (const id of new Set([relation.sourceObjectId, relation.targetObjectId])) byObject.set(id, [...(byObject.get(id) ?? []), relation]);
    }
    return { usable, edgesOf: (id) => byObject.get(id) ?? [], countOf: (id) => byObject.get(id)?.length ?? 0 };
  }, [relations, objects]);
}
