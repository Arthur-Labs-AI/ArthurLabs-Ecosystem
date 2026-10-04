import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ObjectLineage, ThoughtRevision } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useKnowledge } from "../knowledge/knowledge-context";

/** What a list row needs to know about one object's history, without opening its lineage. */
export interface LineageSummary {
  lineage: ObjectLineage;
  revisionCount: number;
  current: ThoughtRevision;
  /** When the object last changed: its current revision's time. */
  updatedAt: string;
}

export interface LineageSummaries {
  status: "loading" | "ready";
  byObject: ReadonlyMap<string, LineageSummary>;
}

const LineageSummariesContext = createContext<LineageSummaries | null>(null);

/**
 * Loads each knowledge object's lineage whenever the objects change (a new distillation, an edit, a merge: all of
 * them re-read the objects). The lineage stays the single source of truth for revisions; this only caches the read.
 */
export function LineageSummariesProvider({ children }: { children: ReactNode }) {
  const client = useArthurClient();
  const { objects } = useKnowledge();
  const [state, setState] = useState<LineageSummaries>({ status: "loading", byObject: new Map() });

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      objects.map((object) =>
        client.getObjectLineage(object.id).then(
          (lineage): [string, LineageSummary] | null => {
            const current = lineage.revisions.find((revision) => revision.id === lineage.currentRevisionId);
            return current ? [object.id, { lineage, revisionCount: lineage.revisions.length, current, updatedAt: current.createdAt }] : null;
          },
          () => null, // one unreadable history must not hide every other object's
        ),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setState({ status: "ready", byObject: new Map(entries.filter((entry): entry is [string, LineageSummary] => entry !== null)) });
    });
    return () => {
      cancelled = true;
    };
  }, [client, objects]);

  const value = useMemo(() => state, [state]);
  return <LineageSummariesContext.Provider value={value}>{children}</LineageSummariesContext.Provider>;
}

export function useLineageSummaries(): LineageSummaries {
  const state = useContext(LineageSummariesContext);
  if (!state) throw new Error("useLineageSummaries must be used inside <ArthurProviders>");
  return state;
}
