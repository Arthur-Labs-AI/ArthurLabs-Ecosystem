import { useCallback, useEffect, useState } from "react";
import type { CognitiveRelation, CreateRelationInput } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface GraphState {
  status: "loading" | "ready" | "error";
  /** Oldest first, as the client returns them. */
  relations: CognitiveRelation[];
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
  const [status, setStatus] = useState<GraphState["status"]>("loading");
  const [relations, setRelations] = useState<CognitiveRelation[]>([]);
  const [inferring, setInferring] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    client.listRelations().then(
      (loaded) => {
        if (cancelled) return;
        setRelations(loaded);
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
  }, [client]);

  /** Re-reads from the store, so what is shown is exactly what is persisted. */
  const refresh = useCallback(async () => {
    try {
      setRelations(await client.listRelations());
      setStatus("ready");
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [client]);

  const infer = useCallback(async (objectIds?: string[]) => {
    if (inferring) return;
    setInferring(true);
    setError(null);
    setNotice(null);
    try {
      const added = await client.inferRelations(objectIds);
      setNotice(added.length === 0 ? "No new connections found." : `Added ${added.length} ${added.length === 1 ? "connection" : "connections"}.`);
      await refresh();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setInferring(false);
    }
  }, [client, inferring, refresh]);

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

  return { status, relations, inferring, creating, notice, error, refresh, infer, create };
}
