import { useCallback, useEffect, useState } from "react";
import type { KnowledgeObject } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface KnowledgeState {
  status: "loading" | "ready" | "error";
  /** Newest distillation first, in reading order within one (as the client returns them). */
  objects: KnowledgeObject[];
  /** The capture currently being distilled, if any. Only one at a time. */
  distilling: string | null;
  /** Captures that were distilled this session and produced nothing. */
  emptyResults: ReadonlySet<string>;
  error: string | null;
  distill: (captureId: string) => Promise<void>;
  /** Re-reads the objects, e.g. after an edit changed their current text. */
  refresh: () => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useKnowledgeState(): KnowledgeState {
  const client = useArthurClient();
  const [status, setStatus] = useState<KnowledgeState["status"]>("loading");
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [distilling, setDistilling] = useState<string | null>(null);
  const [emptyResults, setEmptyResults] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    client.listKnowledgeObjects().then(
      (loaded) => {
        if (cancelled) return;
        setObjects(loaded);
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

  const distill = useCallback(
    async (captureId: string) => {
      if (distilling !== null) return;
      setDistilling(captureId);
      setError(null);
      try {
        const produced = await client.distillCapture(captureId);
        if (produced.length === 0) setEmptyResults((current) => new Set(current).add(captureId));
        // Re-read so order and content are exactly what is stored.
        setObjects(await client.listKnowledgeObjects());
        setStatus("ready");
      } catch (failure) {
        setError(messageOf(failure));
      } finally {
        setDistilling(null);
      }
    },
    [client, distilling],
  );

  const refresh = useCallback(async () => {
    try {
      setObjects(await client.listKnowledgeObjects());
      setStatus("ready");
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [client]);

  return { status, objects, distilling, emptyResults, error, distill, refresh };
}
