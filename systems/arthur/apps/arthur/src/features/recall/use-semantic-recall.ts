import { useCallback, useEffect, useRef, useState } from "react";
import type { SemanticRecallStatus } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface SemanticRecallState {
  status: "loading" | "ready" | "error";
  value: SemanticRecallStatus | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  purge: () => Promise<void>;
}

const POLL_MS = 5000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The semantic-Recall setting. It reads and changes the one native preference; it never looks at an API key, because consent
 * is the user's choice and not something inferred from configuration.
 */
export function useSemanticRecall(): SemanticRecallState {
  const client = useArthurClient();
  const [status, setStatus] = useState<SemanticRecallState["status"]>("loading");
  const [value, setValue] = useState<SemanticRecallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    client.getSemanticRecallStatus().then(
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

  // While ideas are still being indexed, show progress. Nothing polls when the setting is off or nothing is pending.
  const indexing = value !== null && value.enabled && value.pendingObjects > 0;
  useEffect(() => {
    if (!indexing) return;
    const id = window.setInterval(() => {
      client.getSemanticRecallStatus().then(
        (next) => alive.current && setValue(next),
        () => undefined,
      );
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [indexing, client]);

  const run = useCallback(async (operation: () => Promise<SemanticRecallStatus>, done: (next: SemanticRecallStatus) => string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await operation();
      if (!alive.current) return;
      setValue(next);
      setStatus("ready");
      setNotice(done(next));
    } catch (failure) {
      if (alive.current) setError(messageOf(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const setEnabled = useCallback((enabled: boolean) => run(() => client.setSemanticRecallEnabled(enabled), () => (enabled ? "Semantic Recall is on." : "Semantic Recall is off.")), [client, run]);
  const purge = useCallback(() => run(() => client.purgeSemanticIndex(), () => "The semantic index was deleted from this device."), [client, run]);

  return { status, value, busy, error, notice, setEnabled, purge };
}
