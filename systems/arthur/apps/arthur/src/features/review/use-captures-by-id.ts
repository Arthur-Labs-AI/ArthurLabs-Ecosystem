import { useEffect, useState } from "react";
import type { Capture } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface CapturesById {
  captures: ReadonlyMap<string, Capture>;
  /** The read has finished (successfully or not). Until then a missing capture is "not loaded yet", not "gone". */
  ready: boolean;
}

/** The original captures behind a review item, read once per set of ids. Unknown ids are simply absent. */
export function useCapturesById(ids: readonly string[]): CapturesById {
  const client = useArthurClient();
  const [state, setState] = useState<CapturesById>({ captures: new Map(), ready: false });
  const key = [...new Set(ids)].sort().join("|");

  useEffect(() => {
    if (key === "") {
      setState({ captures: new Map(), ready: true });
      return;
    }
    let cancelled = false;
    setState((now) => (now.ready ? { ...now, ready: false } : now));
    client.getCaptures(key.split("|")).then(
      (loaded) => {
        if (!cancelled) setState({ captures: new Map(loaded.map((capture) => [capture.id, capture])), ready: true });
      },
      () => {
        if (!cancelled) setState({ captures: new Map(), ready: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, key]);

  return state;
}
