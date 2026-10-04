import { useState, type FormEvent } from "react";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useCaptures } from "./captures-context";
import type { VoiceState } from "./use-captures";

const VOICE_STATUS: Partial<Record<VoiceState, string>> = {
  starting: "Starting the microphone…",
  recording: "Recording…",
  transcribing: "Transcribing…",
};

export function CapturePanel() {
  const client = useArthurClient();
  const { status, captures, saving, error, save, voiceState, startVoice, stopVoice } = useCaptures();
  const [draft, setDraft] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim().length === 0 || saving) return;
    if (await save(draft)) setDraft("");
  }

  return (
    <section className="panel" aria-labelledby="capture-heading">
      <h2 id="capture-heading" className="panel-title">
        Capture
      </h2>

      {client.capabilities.voiceCapture && (
        <div className="voice-controls">
          {voiceState === "recording" ? (
            <button type="button" className="recording" onClick={() => void stopVoice()}>
              Stop recording
            </button>
          ) : (
            <button type="button" onClick={() => void startVoice()} disabled={voiceState !== "idle"}>
              Start recording
            </button>
          )}
          {VOICE_STATUS[voiceState] && (
            <p role="status" className="voice-status">
              {VOICE_STATUS[voiceState]}
            </p>
          )}
        </div>
      )}

      <form className="capture-form" onSubmit={handleSubmit}>
        <label htmlFor="capture-input" className="visually-hidden">
          Thought
        </label>
        <textarea
          id="capture-input"
          className="capture-input"
          rows={3}
          placeholder="Write a thought…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={saving || draft.trim().length === 0}>
          {saving ? "Saving…" : "Save Capture"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {status === "loading" && <p role="status">Loading captures…</p>}
      {status === "ready" && captures.length === 0 && <p className="muted">No captures yet.</p>}
      {captures.length > 0 && (
        <ul className="capture-list" aria-label="Captures">
          {captures.map((capture) => (
            <li key={capture.id} className="capture-item">
              <p className="capture-content">{capture.content}</p>
              <p className="capture-meta">
                <time dateTime={capture.createdAt}>{capture.createdAt}</time> · {capture.source} · {capture.id.slice(0, 8)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
