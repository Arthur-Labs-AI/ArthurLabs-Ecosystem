import { useState, type FormEvent } from "react";
import {
  RELATION_KINDS,
  isSymmetricRelationKind,
  isRelationKind,
  type CognitiveRelation,
  type CognitiveRelationKind,
  type KnowledgeObject,
} from "@arthur/contracts";
import { useKnowledge } from "../knowledge/knowledge-context";
import { GraphView, type Selection } from "./GraphView";
import { ORIGIN_LABELS, RELATION_LABELS, RELATION_MEANINGS, describeRelation } from "./relation-style";
import { useGraph } from "./use-graph";

function NodeDetails({ object, relations, titleOf }: { object: KnowledgeObject; relations: CognitiveRelation[]; titleOf: (id: string) => string }) {
  const mine = relations.filter((relation) => relation.sourceObjectId === object.id || relation.targetObjectId === object.id);
  return (
    <div className="graph-details" aria-label="Selected object">
      <p className="knowledge-heading">
        <span className={`kind kind-${object.kind}`}>{object.kind}</span> <strong>{object.title}</strong>
      </p>
      <p className="knowledge-body">{object.body}</p>
      <p className="capture-meta">
        Source: capture {object.provenance.captureId.slice(0, 8)} · characters {object.provenance.sourceStart}–{object.provenance.sourceEnd}
      </p>
      <p className="capture-meta">{mine.length === 0 ? "No relations yet." : `${mine.length} ${mine.length === 1 ? "relation" : "relations"}`}</p>
      {mine.length > 0 && (
        <ul className="graph-mini-list">
          {mine.map((relation) => (
            <li key={relation.id}>{describeRelation(relation, titleOf)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EdgeDetails({ relation, titleOf }: { relation: CognitiveRelation; titleOf: (id: string) => string }) {
  const symmetric = isSymmetricRelationKind(relation.kind);
  const source = titleOf(relation.sourceObjectId);
  const target = titleOf(relation.targetObjectId);
  return (
    <div className="graph-details" aria-label="Selected relation">
      <p className="knowledge-heading">
        <strong>Relation: {RELATION_LABELS[relation.kind]}</strong>
      </p>
      <p className="knowledge-body">
        Direction: {symmetric ? `${source} ↔ ${target} (no direction)` : `${source} → ${target}`}
      </p>
      <p className="knowledge-body">Origin: {ORIGIN_LABELS[relation.origin]}</p>
      <p className="capture-meta">
        Created <time dateTime={relation.createdAt}>{relation.createdAt}</time>
      </p>
    </div>
  );
}

function ManualRelationForm({ objects, creating, onCreate }: { objects: KnowledgeObject[]; creating: boolean; onCreate: (kind: CognitiveRelationKind, source: string, target: string) => Promise<boolean> }) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<CognitiveRelationKind>("related_to");
  // Until the user chooses, offer the first two objects.
  const sourceId = objects.some((o) => o.id === source) ? source : (objects[0]?.id ?? "");
  const targetId = objects.some((o) => o.id === target) ? target : (objects.find((o) => o.id !== sourceId)?.id ?? "");
  const valid = sourceId !== "" && targetId !== "" && sourceId !== targetId;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || creating) return;
    await onCreate(kind, sourceId, targetId);
  }

  return (
    <form className="graph-form" onSubmit={handleSubmit} aria-label="Add a relation">
      <label>
        From
        <select value={sourceId} onChange={(event) => setSource(event.target.value)}>
          {objects.map((object) => (
            <option key={object.id} value={object.id}>
              {object.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Relation
        <select
          value={kind}
          onChange={(event) => {
            if (isRelationKind(event.target.value)) setKind(event.target.value);
          }}
        >
          {RELATION_KINDS.map((option) => (
            <option key={option} value={option}>
              {RELATION_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <select value={targetId} onChange={(event) => setTarget(event.target.value)}>
          {objects.map((object) => (
            <option key={object.id} value={object.id}>
              {object.title}
            </option>
          ))}
        </select>
      </label>
      <p className="capture-meta">{RELATION_MEANINGS[kind]}</p>
      {sourceId !== "" && sourceId === targetId && <p role="alert">Choose two different objects.</p>}
      <button type="submit" disabled={!valid || creating}>
        {creating ? "Saving…" : "Add relation"}
      </button>
    </form>
  );
}

export function GraphPanel() {
  const { objects, status: knowledgeStatus } = useKnowledge();
  const { status, relations, inferring, creating, notice, error, refresh, infer, create } = useGraph();
  const [selection, setSelection] = useState<Selection>(null);

  const titleOf = (id: string): string => objects.find((object) => object.id === id)?.title ?? "(unknown object)";
  const selectedObject = selection?.type === "node" ? objects.find((object) => object.id === selection.id) : undefined;
  const selectedRelation = selection?.type === "edge" ? relations.find((relation) => relation.id === selection.id) : undefined;
  // Only draw edges whose two objects are both present, so a stale list can never show a dangling edge.
  const present = new Set(objects.map((object) => object.id));
  const drawable = relations.filter((relation) => present.has(relation.sourceObjectId) && present.has(relation.targetObjectId));

  return (
    <section className="panel" aria-labelledby="graph-heading">
      <h2 id="graph-heading" className="panel-title">
        Cognitive Graph
      </h2>

      <div className="graph-toolbar">
        <button type="button" onClick={() => void infer()} disabled={inferring || objects.length < 2}>
          {inferring ? "Inferring…" : "Infer relations"}
        </button>
        <button type="button" onClick={() => void refresh()} disabled={inferring}>
          Refresh
        </button>
      </div>

      {inferring && <p role="status">Asking the model to propose relations…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {(status === "loading" || knowledgeStatus === "loading") && <p role="status">Loading graph…</p>}

      {objects.length === 0 ? (
        <p className="muted">Distill a capture to create knowledge objects. They appear here as nodes.</p>
      ) : (
        <>
          {objects.length < 2 && <p className="muted">A graph needs at least two knowledge objects to relate.</p>}
          <GraphView objects={objects} relations={drawable} selection={selection} onSelect={setSelection} />

          <ul className="graph-legend" aria-label="Relation kinds">
            {RELATION_KINDS.map((kind) => (
              <li key={kind}>
                <svg width="34" height="10" aria-hidden="true">
                  <line x1="0" y1="5" x2="34" y2="5" className={`graph-legend-line edge-${kind}`} />
                </svg>{" "}
                {RELATION_LABELS[kind]}
                {isSymmetricRelationKind(kind) ? "" : " →"}
              </li>
            ))}
          </ul>

          {selectedObject && <NodeDetails object={selectedObject} relations={drawable} titleOf={titleOf} />}
          {selectedRelation && <EdgeDetails relation={selectedRelation} titleOf={titleOf} />}
          {!selectedObject && !selectedRelation && <p className="muted">Select an object or a relation to see its details.</p>}

          <h3 className="graph-subtitle">Relations</h3>
          {drawable.length === 0 ? (
            <p className="muted">No relations yet. Infer them, or add one yourself.</p>
          ) : (
            <ul className="graph-relations" aria-label="Relations">
              {drawable.map((relation) => (
                <li key={relation.id}>
                  <button type="button" className="link-button" onClick={() => setSelection({ type: "edge", id: relation.id })}>
                    {describeRelation(relation, titleOf)}
                  </button>{" "}
                  <span className="capture-meta">({ORIGIN_LABELS[relation.origin]})</span>
                </li>
              ))}
            </ul>
          )}

          {objects.length >= 2 && (
            <>
              <h3 className="graph-subtitle">Add a relation</h3>
              <ManualRelationForm objects={objects} creating={creating} onCreate={(kind, source, target) => create({ kind, sourceObjectId: source, targetObjectId: target })} />
            </>
          )}
        </>
      )}
    </section>
  );
}
