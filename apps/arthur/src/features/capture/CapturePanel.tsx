import { useState, type FormEvent } from "react";
import { useCaptures } from "./use-captures";

export function CapturePanel() {
  const { status, captures, saving, error, save } = useCaptures();
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
                <time dateTime={capture.createdAt}>{capture.createdAt}</time> · {capture.id.slice(0, 8)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
