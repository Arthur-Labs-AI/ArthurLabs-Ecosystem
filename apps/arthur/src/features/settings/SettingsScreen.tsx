import { useArthurClient } from "../../hooks/use-arthur-client";
import { SemanticRecallSettings } from "../recall/SemanticRecallSettings";
import { useRuntimeInfo } from "./use-runtime-info";
import "./settings.css";

export function SettingsScreen() {
  const client = useArthurClient();
  const state = useRuntimeInfo();

  return (
    <div className="settings">
      <div className="page-head" style={{ padding: 0 }}>
        <div>
          <h1>Settings</h1>
          <p>About this installation</p>
        </div>
      </div>

      <section className="sec" style={{ paddingLeft: 0, paddingRight: 0 }} aria-labelledby="storage-heading">
        <div className="sec-h">
          <h3 id="storage-heading">Your knowledge</h3>
        </div>
        <p className="note">Knowledge stored locally. Captures and everything Arthur organizes from them live on this device.</p>
      </section>

      <section className="sec" style={{ paddingLeft: 0, paddingRight: 0 }} aria-labelledby="recall-heading">
        <div className="sec-h">
          <h3 id="recall-heading">Semantic Recall</h3>
        </div>
        <SemanticRecallSettings variant="desktop" />
      </section>

      <section className="sec" style={{ paddingLeft: 0, paddingRight: 0 }} aria-labelledby="about-heading">
        <div className="sec-h">
          <h3 id="about-heading">About</h3>
        </div>
        <p className="serif" style={{ fontSize: 17, marginBottom: 12 }}>
          A.R.T.H.U.R. Cognitive Runtime
        </p>
        {state.status === "loading" && <p role="status">Loading runtime information…</p>}
        {state.status === "error" && (
          <p role="alert" className="alert">
            Could not read runtime information: {state.message}
          </p>
        )}
        {state.status === "ready" && (
          <dl className="kv">
            <dt>Client</dt>
            <dd>{client.kind}</dd>
            <dt>Platform</dt>
            <dd>{state.info.platform}</dd>
            <dt>App version</dt>
            <dd>{state.info.appVersion}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
