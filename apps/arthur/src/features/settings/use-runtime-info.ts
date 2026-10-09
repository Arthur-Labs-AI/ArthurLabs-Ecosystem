import { useEffect, useState } from "react";
import type { RuntimeInfo } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export type RuntimeInfoState =
  | { status: "loading" }
  | { status: "ready"; info: RuntimeInfo }
  | { status: "error"; message: string };

export function useRuntimeInfo(): RuntimeInfoState {
  const client = useArthurClient();
  const [state, setState] = useState<RuntimeInfoState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    client.getRuntimeInfo().then(
      (info) => {
        if (!cancelled) setState({ status: "ready", info });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  return state;
}
