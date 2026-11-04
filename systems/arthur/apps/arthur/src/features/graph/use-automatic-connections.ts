import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphIntegrationStatus } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface AutomaticConnectionsState {
  status: "loading" | "ready" | "error";
  /** The saved state as reported by the native layer. It is never set from a request that has not been saved. */
  value: GraphIntegrationStatus | null;
  busy: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads and changes the one native Automatic Connections preference through ArthurClient. */
export function useAutomaticConnections(): AutomaticConnectionsState {
  const client = useArthurClient();
  const [status, setStatus] = useState<AutomaticConnectionsState["status"]>("loading");
  const [value, setValue] = useState<GraphIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    client.getGraphIntegration().then(
      (next) => {
        if (cancelled) return;
        setValue(next);
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

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const next = await client.setGraphIntegrationEnabled(enabled);
        if (!alive.current) return;
        setValue(next);
        setStatus("ready");
      } catch (failure) {
        // The saved state stays exactly as it was: a failed save is never shown as the requested value.
        if (alive.current) setError(messageOf(failure));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [client],
  );

  return { status, value, busy, error, setEnabled };
}
