import { Icon } from "../../components/icons";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useRuntimeInfo } from "../settings/use-runtime-info";
import { useMobileNav } from "./mobile-nav";

/** Only what is true today: where knowledge lives, what leaves the device, and what is installed. */
export function MobileSettings() {
  const client = useArthurClient();
  const state = useRuntimeInfo();
  const { closePage } = useMobileNav();

  return (
    <div className="m-page" role="region" aria-label="Settings">
      <div className="m-page-top">
        <button type="button" className="m-iconbtn" aria-label="Back" onClick={closePage}>
          <Icon name="back" />
        </button>
      </div>
      <div className="m-scroll">
        <header className="m-head">
          <div>
            <h1>Settings</h1>
            <p className="m-sub">About this installation</p>
          </div>
        </header>
        <section className="m-set" aria-labelledby="m-set-knowledge">
          <h2 id="m-set-knowledge">Your knowledge</h2>
          <p>Knowledge stored locally. Captures and everything Arthur organizes from them live on this device.</p>
        </section>
        <section className="m-set" aria-labelledby="m-set-cloud">
          <h2 id="m-set-cloud">Voice and organizing</h2>
          <p>Speech is transcribed by a cloud speech service. The recording is deleted once it has been transcribed; only the text is kept.</p>
          <p>Organizing a capture, and finding connections, send the text of your captures and ideas to a cloud model.</p>
        </section>
        <section className="m-set" aria-labelledby="m-set-about">
          <h2 id="m-set-about">About</h2>
          <p className="serif m-product">A.R.T.H.U.R. Cognitive Runtime</p>
          {state.status === "loading" && <p role="status">Loading runtime information…</p>}
          {state.status === "error" && (
            <p role="alert" className="m-note-block err">
              Could not read runtime information: {state.message}
            </p>
          )}
          {state.status === "ready" && (
            <dl className="m-kv">
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
    </div>
  );
}
