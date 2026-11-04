import { useState, type FormEvent } from "react";
import { KNOWLEDGE_OBJECT_KINDS, isKnowledgeObjectKind, type KnowledgeObjectKind, type RevisionChanges } from "@arthur/contracts";
import { KIND_LABELS } from "../../components/icons";
import type { RevisionContent } from "../lineage/RevisionForm";

/**
 * Kind, title and body at touch size, prefilled from `base`. Submits only what differs from it, exactly like the
 * desktop RevisionForm, and lives in a sheet whose action bar stays above the keyboard.
 */
export function MobileRevisionForm({
  formId,
  base,
  allowUnchanged = false,
  onSubmit,
  onProblem,
}: {
  formId: string;
  base: RevisionContent;
  allowUnchanged?: boolean;
  onSubmit: (changes: RevisionChanges, full: RevisionContent) => Promise<boolean>;
  onProblem?: (problem: string | null) => void;
}) {
  const [kind, setKind] = useState<KnowledgeObjectKind>(base.kind);
  const [title, setTitle] = useState(base.title);
  const [body, setBody] = useState(base.body);
  const [problem, setProblem] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const changes: RevisionChanges = {
      ...(kind !== base.kind ? { kind } : {}),
      ...(title !== base.title ? { title } : {}),
      ...(body !== base.body ? { body } : {}),
    };
    if (!allowUnchanged && Object.keys(changes).length === 0) {
      setProblem("Nothing changed.");
      onProblem?.("Nothing changed.");
      return;
    }
    setProblem(null);
    onProblem?.(null);
    await onSubmit(changes, { kind, title, body });
  }

  return (
    <form id={formId} className="m-form" onSubmit={handleSubmit}>
      <label className="m-field">
        <span>Kind</span>
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
      <label className="m-field">
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="m-field">
        <span>Text</span>
        <textarea rows={7} value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="m-note-block">
          {problem}
        </p>
      )}
    </form>
  );
}
