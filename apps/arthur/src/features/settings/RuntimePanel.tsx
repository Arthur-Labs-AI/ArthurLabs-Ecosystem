import { useArthurClient } from "../../hooks/use-arthur-client";
import { useRuntimeInfo } from "./use-runtime-info";

export function RuntimePanel() {
  const client = useArthurClient();
  const state = useRuntimeInfo();

  return (
    <section className="panel" aria-labelledby="runtime-heading">
      <h2 id="runtime-heading" className="panel-title">
        Runtime
      </h2>
      {state.status === "loading" && <p role="status">Loading runtime information…</p>}
      {state.status === "error" && <p role="alert">Could not read runtime information: {state.message}</p>}
      {state.status === "ready" && (
        <dl className="facts">
          <dt>Client</dt>
          <dd>{client.kind}</dd>
          <dt>Platform</dt>
          <dd>{state.info.platform}</dd>
          <dt>App version</dt>
          <dd>{state.info.appVersion}</dd>
        </dl>
      )}
    </section>
  );
}
