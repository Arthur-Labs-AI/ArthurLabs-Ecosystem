import { useState } from "react";
import { useSemanticRecall } from "./use-semantic-recall";
import "./recall.css";

/**
 * The one place semantic Recall is switched on or off. It is a setting, not a prompt: Ask Arthur never interrupts a question to
 * ask for it, and it works fully without it (matching the words of your ideas). The wording says exactly what leaves the device
 * and what stays on it.
 */
export function SemanticRecallSettings({ variant }: { variant: "desktop" | "mobile" }) {
  const semantic = useSemanticRecall();
  const [confirming, setConfirming] = useState(false);
  const button = variant === "mobile" ? "m-pbtn" : "btn";
  const value = semantic.value;
  const stored = value?.storedVectorsAllKeys ?? 0;

  return (
    <div className="sr" data-variant={variant}>
      <p>
        Ask Arthur always finds ideas by the words you used. Semantic Recall also finds ideas that mean the same thing in different words. It is off until you
        turn it on.
      </p>

      {semantic.status === "loading" && <p role="status">Reading the setting…</p>}
      {semantic.status === "error" && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          Could not read the semantic Recall setting: {semantic.error}
        </p>
      )}

      {value && (
        <>
          <label className="sr-toggle">
            <input type="checkbox" role="switch" checked={value.enabled} disabled={semantic.busy} onChange={(event) => void semantic.setEnabled(event.target.checked)} />
            <span>Use semantic Recall</span>
            <b className="sr-onoff">{value.enabled ? "On" : "Off"}</b>
          </label>
          {value.settingsCorrupt && <p role="alert">The saved preference couldn’t be read, so semantic Recall stays off until you choose again.</p>}
          {value.enabled && (
            <p className="sr-state" role="status">
              {value.pendingObjects > 0
                ? `Indexing: ${value.storedVectors} ${value.storedVectors === 1 ? "idea" : "ideas"} done, ${value.pendingObjects} waiting.`
                : `${value.storedVectors} ${value.storedVectors === 1 ? "idea is" : "ideas are"} indexed on this device.`}
            </p>
          )}
          {!value.enabled && stored > 0 && <p className="sr-state">{stored} stored {stored === 1 ? "vector is" : "vectors are"} kept on this device but ignored while this is off.</p>}
        </>
      )}

      <ul className="sr-list">
        <li>Turning it on sends the text of your ideas, and of the questions you ask, to the embedding service this app is set up to use.</li>
        <li>The index built from that text stays on this device.</li>
        <li>Turning it off stops new embedding requests straight away. The stored index is kept but ignored.</li>
        <li>Deleting the index removes it from this device. Your knowledge is not touched, and Ask Arthur keeps working.</li>
      </ul>

      {semantic.error && semantic.status !== "error" && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          {semantic.error}
        </p>
      )}
      {semantic.notice && <p role="status">{semantic.notice}</p>}

      <div className="sr-actions">
        {!confirming ? (
          <button type="button" className={button} disabled={semantic.busy || stored === 0} onClick={() => setConfirming(true)}>
            Delete semantic index
          </button>
        ) : (
          <>
            <button
              type="button"
              className={button}
              disabled={semantic.busy}
              onClick={() => {
                setConfirming(false);
                void semantic.purge();
              }}
            >
              Delete {stored} {stored === 1 ? "vector" : "vectors"}
            </button>
            <button type="button" className={variant === "mobile" ? "m-pbtn ghost" : "btn ghost"} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        )}
      </div>
    </div>
  );
}
