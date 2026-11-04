import { useCallback, useEffect, useRef, useState } from "react";
import type { EvolutionConsentKind, EvolutionStatus } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface EvolutionSettingsState {
  status: "loading" | "ready" | "error";
  /** The saved state as reported by the native layer. It is never set from a request that has not been saved. */
  value: EvolutionStatus | null;
  busy: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  setConsent: (kind: EvolutionConsentKind, granted: boolean, disclosureVersion?: string) => Promise<void>;
  saveTypesafeKey: (secret: string) => Promise<boolean>;
  removeTypesafeKey: () => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads and changes the Automatic Thought Evolution settings through ArthurClient. A failed change leaves the shown state untouched. */
export function useEvolutionSettings(): EvolutionSettingsState {
  const client = useArthurClient();
  const [status, setStatus] = useState<EvolutionSettingsState["status"]>("loading");
  const [value, setValue] = useState<EvolutionStatus | null>(null);
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
    client.getEvolutionStatus().then(
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

  const change = useCallback(async (work: () => Promise<EvolutionStatus>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (!alive.current) return true;
      setValue(next);
      setStatus("ready");
      return true;
    } catch (failure) {
      if (alive.current) setError(messageOf(failure));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  return {
    status,
    value,
    busy,
    error,
    setEnabled: useCallback((enabled: boolean) => change(() => client.setEvolutionEnabled(enabled)).then(() => undefined), [change, client]),
    setConsent: useCallback((kind, granted, disclosureVersion) => change(() => client.setEvolutionConsent(kind, granted, disclosureVersion)).then(() => undefined), [change, client]),
    saveTypesafeKey: useCallback((secret: string) => change(() => client.setTypesafeCredential(secret)), [change, client]),
    removeTypesafeKey: useCallback(() => change(() => client.deleteTypesafeCredential()).then(() => undefined), [change, client]),
  };
}
