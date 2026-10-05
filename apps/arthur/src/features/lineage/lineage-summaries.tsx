import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { KnowledgeObject, ObjectLineage, ThoughtRevision } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useKnowledge } from "../knowledge/knowledge-context";

/** What a list row needs to know about one object, without opening its history. */
export interface LineageSummary {
  revisionCount: number;
  /** When the object last changed: its current revision's time. */
  updatedAt: string;
  /** Relations the object is an end of (from the same read; screens that draw the graph count its edges themselves). */
  relationCount: number;
  currentRevisionId: string;
}

export interface LineageSummaries {
  status: "loading" | "ready";
  byObject: ReadonlyMap<string, LineageSummary>;
  /** The history of one object, if it is known yet. An object with a single revision is known without asking. */
  lineageOf: (objectId: string) => ObjectLineage | undefined;
  /** Asks for the histories of these objects (those with more than one revision are read, once each). */
  request: (objectIds: readonly string[]) => void;
}

const LineageSummariesContext = createContext<LineageSummaries | null>(null);

/**
 * An object that was never edited has exactly one revision, and it is the object as it was distilled: same kind,
 * title and body, created with it, carrying the object's own source span. So its history needs no read.
 */
function initialLineage(object: KnowledgeObject, currentRevisionId: string): ObjectLineage {
  const revision: ThoughtRevision = {
    id: currentRevisionId,
    objectId: object.id,
    kind: object.kind,
    title: object.title,
    body: object.body,
    createdAt: object.createdAt,
    origin: "initial",
    provenance: { ...object.provenance },
    parentRevisionIds: [],
  };
  return { objectId: object.id, revisions: [revision], currentRevisionId };
}

/**
 * One request reads the summary of EVERY object (`getKnowledgeSummaries`), so a list never costs one read per idea.
 * A full history is read only for an object that has more than one revision and only when a screen asks for it
 * (`useObjectLineage`). The lineage stays the single source of truth for revisions; this caches the read and drops an
 * entry as soon as the summary says the object changed.
 */
export function LineageSummariesProvider({ children }: { children: ReactNode }) {
  const client = useArthurClient();
  const { objects, status: knowledgeStatus } = useKnowledge();
  const [summaries, setSummaries] = useState<{ status: "loading" | "ready"; byObject: ReadonlyMap<string, LineageSummary> }>({ status: "loading", byObject: new Map() });
  const [cache, setCache] = useState<ReadonlyMap<string, ObjectLineage>>(new Map());
  const asked = useRef(new Set<string>());

  useEffect(() => {
    // Wait for the objects: summaries for a list that has not loaded yet would be a wasted request.
    if (knowledgeStatus !== "ready") return;
    let cancelled = false;
    client.getKnowledgeSummaries().then(
      (loaded) => {
        if (cancelled) return;
        const byObject = new Map(loaded.map((entry): [string, LineageSummary] => [entry.objectId, { revisionCount: entry.revisionCount, updatedAt: entry.updatedAt, relationCount: entry.relationCount, currentRevisionId: entry.currentRevisionId }]));
        setSummaries({ status: "ready", byObject });
        // A cached history that no longer matches the summary is stale: forget it, and let the screen ask again.
        setCache((current) => {
          const next = new Map(current);
          for (const [id, lineage] of current) {
            const summary = byObject.get(id);
            if (!summary || summary.revisionCount !== lineage.revisions.length || summary.currentRevisionId !== lineage.currentRevisionId) {
              next.delete(id);
              asked.current.delete(id);
            }
          }
          return next.size === current.size ? current : next;
        });
      },
      () => {
        if (!cancelled) setSummaries({ status: "ready", byObject: new Map() }); // one unreadable summary must not hide the objects
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, objects, knowledgeStatus]);

  const request = useCallback(
    (objectIds: readonly string[]) => {
      for (const id of objectIds) {
        const summary = summaries.byObject.get(id);
        if (!summary || summary.revisionCount <= 1 || asked.current.has(id)) continue;
        asked.current.add(id);
        client.getObjectLineage(id).then(
          (lineage) => setCache((current) => new Map(current).set(id, lineage)),
          () => asked.current.delete(id),
        );
      }
    },
    [client, summaries.byObject],
  );

  const objectsById = useMemo(() => new Map(objects.map((object) => [object.id, object])), [objects]);
  const lineageOf = useCallback(
    (objectId: string): ObjectLineage | undefined => {
      const summary = summaries.byObject.get(objectId);
      const object = objectsById.get(objectId);
      if (summary && object && summary.revisionCount === 1) return initialLineage(object, summary.currentRevisionId);
      return cache.get(objectId);
    },
    [summaries.byObject, objectsById, cache],
  );

  const value = useMemo<LineageSummaries>(() => ({ status: summaries.status, byObject: summaries.byObject, lineageOf, request }), [summaries, lineageOf, request]);
  return <LineageSummariesContext.Provider value={value}>{children}</LineageSummariesContext.Provider>;
}

export function useLineageSummaries(): LineageSummaries {
  const state = useContext(LineageSummariesContext);
  if (!state) throw new Error("useLineageSummaries must be used inside <ArthurProviders>");
  return state;
}

/** The history of one object for a screen that draws it. Read lazily, cached, and refreshed when the object changes. */
export function useObjectLineage(objectId: string | null): ObjectLineage | undefined {
  const { lineageOf, request, byObject } = useLineageSummaries();
  useEffect(() => {
    if (objectId !== null) request([objectId]);
  }, [objectId, request, byObject]);
  return objectId === null ? undefined : lineageOf(objectId);
}
