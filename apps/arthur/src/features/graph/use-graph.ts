import { useCallback, useEffect, useRef, useState } from "react";
import type { CognitiveRelation, CreateRelationInput, ExternalObject } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useProjects } from "../projects/projects-context";

export interface GraphState {
  status: "loading" | "ready" | "error";
  /**
   * Oldest first. The ACTIVE project's graph projection: relations between its own ideas, plus those that cross to another
   * project (whose far end is in `externalObjects`). Nothing else from other projects.
   */
  relations: CognitiveRelation[];
  /** The far ends of the cross-project relations, each with the project it belongs to. Never the rest of that project. */
  externalObjects: ExternalObject[];
  inferring: boolean;
  creating: boolean;
  /** A non-error outcome worth telling the user, e.g. how many relations an inference run added. */
  notice: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Asks the model to propose connections; `objectIds` widens the candidate set to include those objects. */
  infer: (objectIds?: string[]) => Promise<void>;
  /** Resolves true when the relation was stored. */
  create: (input: CreateRelationInput) => Promise<boolean>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useGraph(): GraphState {
  const client = useArthurClient();
  const { activeProjectId, dataVersion } = useProjects();
  const [status, setStatus] = useState<GraphState["status"]>("loading");
  const [relations, setRelations] = useState<CognitiveRelation[]>([]);
  const [externalObjects, setExternalObjects] = useState<ExternalObject[]>([]);
  const shownScope = useRef<string | null>(null);
  const [inferring, setInferring] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeProjectId === null) return;
    let cancelled = false;
    if (shownScope.current !== activeProjectId) {
      shownScope.current = activeProjectId;
      setRelations([]);
      setExternalObjects([]);
    }
    setStatus("loading");
    client.getProjectGraph(activeProjectId).then(
      (loaded) => {
        if (cancelled) return;
        setRelations(loaded.relations);
        setExternalObjects(loaded.externalObjects);
        setStatus("ready");
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(messageOf(failure));
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, activeProjectId, dataVersion]);

  /** Re-reads from the store, so what is shown is exactly what is persisted. */
  const refresh = useCallback(async () => {
    if (activeProjectId === null) return;
    try {
      const loaded = await client.getProjectGraph(activeProjectId);
      setRelations(loaded.relations);
      setExternalObjects(loaded.externalObjects);
      setStatus("ready");
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [client, activeProjectId]);

  // Background integration may add or remove relations while this screen is open: re-read what is persisted.
  useEffect(() => {
    if (!client.onGraphChanged) return;
    return client.onGraphChanged(() => void refresh());
  }, [client, refresh]);

  const infer = useCallback(async (objectIds?: string[]) => {
    if (inferring) return;
    setInferring(true);
    setError(null);
    setNotice(null);
    try {
      const added = await client.inferRelations(objectIds, activeProjectId === null ? undefined : { projectId: activeProjectId });
      setNotice(added.length === 0 ? "No new connections found." : `Added ${added.length} ${added.length === 1 ? "connection" : "connections"}.`);
      await refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setInferring(false);
    }
  }, [client, inferring, refresh, activeProjectId]);

  const create = useCallback(
    async (input: CreateRelationInput) => {
      if (creating) return false;
      setCreating(true);
      setError(null);
      setNotice(null);
      try {
        await client.createRelation(input);
        setNotice("Connection saved.");
        await refresh();
        return true;
      } catch (failure) {
        setError(messageOf(failure));
        return false;
      } finally {
        setCreating(false);
      }
    },
    [client, creating, refresh],
  );

  return { status, relations, externalObjects, inferring, creating, notice, error, refresh, infer, create };
}
