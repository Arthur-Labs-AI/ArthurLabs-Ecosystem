import { useMemo } from "react";
import type { CognitiveRelation, ExternalObject } from "@arthur/contracts";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useGraphState } from "./graph-context";

export interface RelationIndex {
  /**
   * Only relations whose two objects are both known (this project's own, or the far end of a cross-project relation),
   * so a stale list can never show a dangling edge.
   */
  usable: CognitiveRelation[];
  /** The far ends of the cross-project relations, with their project. */
  external: ExternalObject[];
  /** The external object with this id, or `undefined` for one of the active project's own ideas. */
  externalOf: (objectId: string) => ExternalObject | undefined;
  edgesOf: (objectId: string) => CognitiveRelation[];
  countOf: (objectId: string) => number;
}

export function useRelationIndex(): RelationIndex {
  const { relations, externalObjects } = useGraphState();
  const { objects } = useKnowledge();
  return useMemo(() => {
    const own = new Set(objects.map((object) => object.id));
    const externalById = new Map(externalObjects.filter((object) => !own.has(object.id)).map((object) => [object.id, object]));
    const known = (id: string): boolean => own.has(id) || externalById.has(id);
    // An external end is only meaningful next to one of this project's own ideas.
    const usable = relations.filter((relation) => known(relation.sourceObjectId) && known(relation.targetObjectId) && (own.has(relation.sourceObjectId) || own.has(relation.targetObjectId)));
    const byObject = new Map<string, CognitiveRelation[]>();
    for (const relation of usable) {
      for (const id of new Set([relation.sourceObjectId, relation.targetObjectId])) byObject.set(id, [...(byObject.get(id) ?? []), relation]);
    }
    const shownExternal = [...externalById.values()].filter((object) => byObject.has(object.id));
    return {
      usable,
      external: shownExternal,
      externalOf: (id) => externalById.get(id),
      edgesOf: (id) => byObject.get(id) ?? [],
      countOf: (id) => byObject.get(id)?.length ?? 0,
    };
  }, [relations, externalObjects, objects]);
}
