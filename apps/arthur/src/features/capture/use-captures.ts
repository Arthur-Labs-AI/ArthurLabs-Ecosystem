import { useCallback, useEffect, useState } from "react";
import type { Capture } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface CapturesState {
  status: "loading" | "ready" | "error";
  captures: Capture[];
  saving: boolean;
  /** Last load or save failure. Cleared by the next successful operation. */
  error: string | null;
  /** Resolves true when the capture was durably saved. */
  save: (content: string) => Promise<boolean>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useCaptures(): CapturesState {
  const client = useArthurClient();
  const [status, setStatus] = useState<CapturesState["status"]>("loading");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    client.listCaptures().then(
      (loaded) => {
        if (cancelled) return;
        setCaptures(loaded);
        setError(null);
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

  const save = useCallback(
    async (content: string): Promise<boolean> => {
      setSaving(true);
      try {
        const created = await client.createCapture({ source: "text", content });
        setCaptures((current) => [created, ...current]);
        setError(null);
        setStatus("ready");
        return true;
      } catch (failure) {
        setError(messageOf(failure));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client],
  );

  return { status, captures, saving, error, save };
}
