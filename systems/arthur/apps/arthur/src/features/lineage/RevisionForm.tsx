import { useState, type FormEvent } from "react";
import { KNOWLEDGE_OBJECT_KINDS, isKnowledgeObjectKind, type KnowledgeObjectKind, type RevisionChanges } from "@arthur/contracts";
import { KIND_LABELS } from "../../components/icons";

export interface RevisionContent {
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
}

/**
 * Kind, title and body, prefilled from `base`. Submits only what differs from it. Used to revise an idea, to branch
 * from a revision, and (with `allowUnchanged`) to write the result of a merge.
 */
export function RevisionForm({
  label,
  base,
  submitLabel,
  busy,
  allowUnchanged = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  base: RevisionContent;
  submitLabel: string;
  busy: boolean;
  /** A merge may deliberately keep one parent's text as it is; an edit or a branch may not be a no-op. */
  allowUnchanged?: boolean;
  onSubmit: (changes: RevisionChanges, full: RevisionContent) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<KnowledgeObjectKind>(base.kind);
  const [title, setTitle] = useState(base.title);
  const [body, setBody] = useState(base.body);
  const [problem, setProblem] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const changes: RevisionChanges = {
      ...(kind !== base.kind ? { kind } : {}),
      ...(title !== base.title ? { title } : {}),
      ...(body !== base.body ? { body } : {}),
    };
    if (!allowUnchanged && Object.keys(changes).length === 0) {
      setProblem("Nothing changed.");
      return;
    }
    setProblem(null);
    await onSubmit(changes, { kind, title, body });
  }

  return (
    <form className="form" aria-label={label} onSubmit={handleSubmit}>
      <label className="field">
        Kind
        <select
          value={kind}
          onChange={(event) => {
            if (isKnowledgeObjectKind(event.target.value)) setKind(event.target.value);
          }}
        >
          {KNOWLEDGE_OBJECT_KINDS.map((option) => (
            <option key={option} value={option}>
              {KIND_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Title
        <input className="title-input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        Body
        <textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="alert">
          {problem}
        </p>
      )}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
