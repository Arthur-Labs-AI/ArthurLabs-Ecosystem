import { useState, type FormEvent } from "react";
import { KNOWLEDGE_OBJECT_KINDS, isKnowledgeObjectKind, type DiffSegment, type KnowledgeObjectKind, type RevisionChanges, type RevisionDiff, type RevisionOrigin, type ThoughtRevision } from "@arthur/contracts";
import { useKnowledge } from "../knowledge/knowledge-context";
import { LineageGraph } from "./LineageGraph";
import { useLineage } from "./use-lineage";

const ORIGIN_LABELS: Record<RevisionOrigin, string> = {
  initial: "Initial revision",
  user_edit: "Edited by you",
  distillation: "Interpreted from a new capture",
  merge: "Merge",
  system: "Created by Arthur",
};

function Segments({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.op === "insert" ? (
          <ins key={index}>{segment.text}</ins>
        ) : segment.op === "delete" ? (
          <del key={index}>{segment.text}</del>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function DiffView({ diff, fromLabel, toLabel }: { diff: RevisionDiff; fromLabel: string; toLabel: string }) {
  return (
    <div className="lineage-diff" aria-label={`Changes from ${fromLabel} to ${toLabel}`}>
      <p className="capture-meta">
        Changes from {fromLabel} to {toLabel}
      </p>
      <p>{diff.kind.changed ? `Kind: ${diff.kind.from} → ${diff.kind.to}` : "Kind unchanged."}</p>
      <p className="lineage-diff-text" aria-label="Title changes">
        {diff.title.changed ? <Segments segments={diff.title.segments} /> : "Title unchanged."}
      </p>
      <p className="lineage-diff-text" aria-label="Body changes">
        {diff.body.changed ? <Segments segments={diff.body.segments} /> : "Body unchanged."}
      </p>
    </div>
  );
}

/** Title, body and kind, prefilled. Submits only what differs from `base`. */
function RevisionForm({
  label,
  base,
  submitLabel,
  busy,
  allowUnchanged = false,
  onSubmit,
}: {
  label: string;
  base: { kind: KnowledgeObjectKind; title: string; body: string };
  submitLabel: string;
  busy: boolean;
  /** A merge may deliberately keep one parent's text as it is; an edit or a branch may not be a no-op. */
  allowUnchanged?: boolean;
  onSubmit: (changes: RevisionChanges, full: { kind: KnowledgeObjectKind; title: string; body: string }) => Promise<boolean>;
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
    <form className="graph-form" aria-label={label} onSubmit={handleSubmit}>
      <label>
        Kind
        <select
          value={kind}
          onChange={(event) => {
            if (isKnowledgeObjectKind(event.target.value)) setKind(event.target.value);
          }}
        >
          {KNOWLEDGE_OBJECT_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Body
        <textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      {problem && <p role="alert">{problem}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function LineagePanel() {
  const { objects, refresh } = useKnowledge();
  const [chosen, setChosen] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [makeMergeCurrent, setMakeMergeCurrent] = useState(true);

  const objectId = chosen !== null && objects.some((object) => object.id === chosen) ? chosen : (objects[0]?.id ?? null);
  const { status, lineage, diffs, busy, notice, error, edit, branch, merge } = useLineage(objectId, selectedId, refresh);

  const revisions = lineage?.revisions ?? [];
  const labelOf = (id: string): string => `R${revisions.findIndex((revision) => revision.id === id) + 1}`;
  const selected: ThoughtRevision | undefined = revisions.find((revision) => revision.id === selectedId) ?? revisions.find((revision) => revision.id === lineage?.currentRevisionId);
  const current = revisions.find((revision) => revision.id === lineage?.currentRevisionId);
  const pickedRevisions = revisions.filter((revision) => picked.includes(revision.id));

  function togglePick(id: string) {
    setPicked((now) => (now.includes(id) ? now.filter((existing) => existing !== id) : [...now, id]));
  }

  return (
    <section className="panel" aria-labelledby="lineage-heading">
      <h2 id="lineage-heading" className="panel-title">
        Thought Lineage
      </h2>
      <p className="muted">How one thought evolved. Each edit is a new revision; nothing is overwritten. This is separate from the graph and from where the thought was first captured.</p>

      {objects.length === 0 ? (
        <p className="muted">Distill a capture to create a knowledge object, then its history appears here.</p>
      ) : (
        <>
          <label className="lineage-picker">
            Knowledge object
            <select
              value={objectId ?? ""}
              onChange={(event) => {
                setChosen(event.target.value);
                setSelectedId(null);
                setPicked([]);
              }}
            >
              {objects.map((object) => (
                <option key={object.id} value={object.id}>
                  {object.title}
                </option>
              ))}
            </select>
          </label>

          {status === "loading" && <p role="status">Loading history…</p>}
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}

          {lineage && current && selected && (
            <>
              <LineageGraph revisions={revisions} currentRevisionId={lineage.currentRevisionId} selectedRevisionId={selected.id} onSelect={setSelectedId} />

              <ul className="lineage-list" aria-label="Revisions">
                {revisions.map((revision) => (
                  <li key={revision.id}>
                    <label className="lineage-pick">
                      <input type="checkbox" aria-label={`Merge ${labelOf(revision.id)}`} checked={picked.includes(revision.id)} onChange={() => togglePick(revision.id)} />
                    </label>
                    <button type="button" className="link-button" aria-pressed={revision.id === selected.id} onClick={() => setSelectedId(revision.id)}>
                      {labelOf(revision.id)} · {ORIGIN_LABELS[revision.origin]}
                      {revision.id === lineage.currentRevisionId ? " · current" : ""}
                    </button>
                    {revision.parentRevisionIds.length > 0 && <span className="capture-meta"> from {revision.parentRevisionIds.map(labelOf).join(" + ")}</span>}
                  </li>
                ))}
              </ul>

              <div className="graph-details" aria-label="Selected revision">
                <p className="knowledge-heading">
                  <strong>
                    Revision {labelOf(selected.id)}
                    {selected.id === lineage.currentRevisionId ? " (current)" : ""}
                  </strong>{" "}
                  <span className={`kind kind-${selected.kind}`}>{selected.kind}</span>
                </p>
                <p className="knowledge-heading">
                  <strong>{selected.title}</strong>
                </p>
                <p className="knowledge-body">{selected.body}</p>
                <p className="capture-meta">
                  {ORIGIN_LABELS[selected.origin]} · <time dateTime={selected.createdAt}>{selected.createdAt}</time>
                </p>
                <p className="capture-meta">
                  {selected.provenance
                    ? `Source: capture ${selected.provenance.captureId.slice(0, 8)} · characters ${selected.provenance.sourceStart}–${selected.provenance.sourceEnd}`
                    : "No direct Capture source: this text was written in an edit, not interpreted from a Capture."}
                </p>
                <p className="capture-meta">{selected.parentRevisionIds.length === 0 ? "No parent: this is where the history starts." : `Parents: ${selected.parentRevisionIds.map(labelOf).join(", ")}`}</p>
                {selected.parentRevisionIds.map((parentId) => {
                  const diff = diffs.get(parentId);
                  return diff ? <DiffView key={parentId} diff={diff} fromLabel={labelOf(parentId)} toLabel={labelOf(selected.id)} /> : null;
                })}
              </div>

              <h3 className="graph-subtitle">Edit</h3>
              <RevisionForm key={`edit-${current.id}`} label="Edit this thought" base={current} submitLabel="Save as new revision" busy={busy} onSubmit={(changes) => edit(changes)} />

              <h3 className="graph-subtitle">Branch</h3>
              <RevisionForm
                key={`branch-${selected.id}`}
                label="Branch from the selected revision"
                base={selected}
                submitLabel={`Branch from ${labelOf(selected.id)}`}
                busy={busy}
                onSubmit={(changes) => branch(selected.id, changes)}
              />

              <h3 className="graph-subtitle">Merge</h3>
              {pickedRevisions.length < 2 ? (
                <p className="muted">Tick two or more revisions in the list to merge them into a new one.</p>
              ) : (
                <>
                  <label className="lineage-pick">
                    <input type="checkbox" checked={makeMergeCurrent} onChange={(event) => setMakeMergeCurrent(event.target.checked)} /> Make the merge the current revision
                  </label>
                  <RevisionForm
                    key={`merge-${pickedRevisions.map((revision) => revision.id).join("+")}`}
                    label="Merge the ticked revisions"
                    base={pickedRevisions[pickedRevisions.length - 1] as ThoughtRevision}
                    submitLabel={`Merge ${pickedRevisions.map((revision) => labelOf(revision.id)).join(" + ")}`}
                    busy={busy}
                    allowUnchanged
                    onSubmit={async (_changes, full) => {
                      const done = await merge(pickedRevisions.map((revision) => revision.id), full, makeMergeCurrent);
                      if (done) setPicked([]);
                      return done;
                    }}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
