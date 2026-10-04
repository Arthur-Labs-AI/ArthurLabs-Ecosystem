import { useMemo, useState, type FormEvent } from "react";
import { RELATION_KINDS, isRelationKind, isSymmetricRelationKind, type CognitiveRelation, type CognitiveRelationKind, type KnowledgeObject } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { Icon, KIND_LABELS, KindGlyph } from "../../components/icons";
import { RelationSwatch } from "../../components/RelationArt";
import { formatMoment } from "../../components/format";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useLineageSummaries } from "../lineage/lineage-summaries";
import { GraphCanvas, type Selection } from "./GraphCanvas";
import { useGraphState } from "./graph-context";
import { useRelationIndex } from "./relation-index";
import { ORIGIN_LABELS, RELATION_LABELS, RELATION_MEANINGS, relationVerbFrom } from "./relation-style";
import "./connections.css";

type OriginFilter = "all" | "yours" | "arthur";
const ORIGIN_FILTERS: { value: OriginFilter; label: string }[] = [
  { value: "all", label: "All links" },
  { value: "yours", label: "Yours" },
  { value: "arthur", label: "Arthur's" },
];

const matchesOrigin = (relation: CognitiveRelation, filter: OriginFilter): boolean => filter === "all" || (filter === "yours" ? relation.origin === "user" : relation.origin !== "user");

function OriginDot({ relation }: { relation: CognitiveRelation }) {
  return <span className={relation.origin === "model" ? "origin model" : "origin"} aria-hidden="true" />;
}

/** Create a connection FROM the selected idea: "<this idea> <relation> <other idea>". */
function ConnectForm({ from, others, creating, onCreate }: { from: KnowledgeObject; others: KnowledgeObject[]; creating: boolean; onCreate: (kind: CognitiveRelationKind, targetId: string) => Promise<boolean> }) {
  const [kind, setKind] = useState<CognitiveRelationKind>("related_to");
  const [target, setTarget] = useState("");
  const targetId = others.some((o) => o.id === target) ? target : (others[0]?.id ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (targetId === "" || creating) return;
    await onCreate(kind, targetId);
  }

  return (
    <form className="form" aria-label="Add a connection" onSubmit={handleSubmit}>
      <p className="note">
        <span className="serif" style={{ color: "var(--ink)" }}>
          {from.title}
        </span>
      </p>
      <label className="field">
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
      <label className="field">
        To
        <select value={targetId} onChange={(event) => setTarget(event.target.value)}>
          {others.map((object) => (
            <option key={object.id} value={object.id}>
              {object.title}
            </option>
          ))}
        </select>
      </label>
      <p className="note">{RELATION_MEANINGS[kind]}</p>
      <div className="row-actions">
        <button type="submit" className="btn" disabled={targetId === "" || creating}>
          {creating ? "Saving…" : "Add connection"}
        </button>
      </div>
    </form>
  );
}

export function ConnectionsScreen() {
  const { objects, status: knowledgeStatus } = useKnowledge();
  const { status, inferring, creating, notice, error, refresh, infer, create } = useGraphState();
  const { byObject } = useLineageSummaries();
  const index = useRelationIndex();
  const { focusId, focus, go } = useNavigation();

  const [selection, setSelection] = useState<Selection>(focusId ? { type: "node", id: focusId } : null);
  const [view, setView] = useState<"map" | "list">("map");
  const [enabled, setEnabled] = useState<ReadonlySet<CognitiveRelationKind>>(new Set(RELATION_KINDS));
  const [origin, setOrigin] = useState<OriginFilter>("all");

  const byId = useMemo(() => new Map(objects.map((object) => [object.id, object])), [objects]);
  const titleOf = (id: string): string => byId.get(id)?.title ?? "(unknown idea)";
  const shown = useMemo(() => index.usable.filter((relation) => enabled.has(relation.kind) && matchesOrigin(relation, origin)), [index.usable, enabled, origin]);

  const select = (next: Selection) => {
    setSelection(next);
    if (next?.type === "node") focus(next.id);
  };

  const node = selection?.type === "node" ? byId.get(selection.id) : undefined;
  const edge = selection?.type === "edge" ? index.usable.find((relation) => relation.id === selection.id) : undefined;

  const toggleKind = (kind: CognitiveRelationKind) =>
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <div className="conn">
      <section className="stage" aria-label="Connections">
        <div className="page-head">
          <div>
            <h1>Connections</h1>
            <p>
              {objects.length} {objects.length === 1 ? "idea" : "ideas"}, {index.usable.length} {index.usable.length === 1 ? "link" : "links"}
            </p>
          </div>
          <span className="spacer" />
          <div className="view-toggle" role="group" aria-label="View">
            <button type="button" className="btn" aria-pressed={view === "map"} onClick={() => setView("map")}>
              <Icon name="graph" small />
              Map
            </button>
            <button type="button" className="btn ghost" aria-pressed={view === "list"} onClick={() => setView("list")}>
              <Icon name="list" small />
              List
            </button>
          </div>
          <button type="button" className="btn" onClick={() => void infer()} disabled={inferring || objects.length < 2} title="Asks the model to propose links between your ideas">
            <Icon name="wand" small />
            {inferring ? "Finding…" : "Find connections"}
          </button>
          <button type="button" className="btn ghost" onClick={() => void refresh()} disabled={inferring}>
            Refresh
          </button>
        </div>

        <div className="page-head" style={{ paddingTop: 8, minHeight: 20 }} aria-live="polite">
          {inferring && <p role="status">Looking for connections…</p>}
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          {(status === "loading" || knowledgeStatus === "loading") && <p role="status">Loading connections…</p>}
        </div>

        {objects.length === 0 && knowledgeStatus === "ready" ? (
          <div className="state">
            <h2>Nothing to connect yet</h2>
            <p>Capture a thought. Once Arthur has organized it into ideas, they appear here as a map.</p>
          </div>
        ) : view === "map" ? (
          <div className="canvas" onClick={() => setSelection(null)}>
            <div className="seg flat origin-filter" role="group" aria-label="Show links by origin" onClick={(event) => event.stopPropagation()}>
              {ORIGIN_FILTERS.map((option) => (
                <button key={option.value} type="button" aria-pressed={origin === option.value} onClick={() => setOrigin(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
            <div className="graph-frame">
              <GraphCanvas objects={objects} relations={index.usable} selection={selection} onSelect={select} enabledKinds={enabled} isShown={(relation) => matchesOrigin(relation, origin)} />
            </div>
            <div className="legend" role="group" aria-label="Relation types" onClick={(event) => event.stopPropagation()}>
              {RELATION_KINDS.map((kind) => (
                <button key={kind} type="button" aria-pressed={enabled.has(kind)} onClick={() => toggleKind(kind)}>
                  <RelationSwatch kind={kind} />
                  <span>{RELATION_LABELS[kind]}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="listview">
            <div className="seg flat" role="group" aria-label="Show links by origin" style={{ marginBottom: 8 }}>
              {ORIGIN_FILTERS.map((option) => (
                <button key={option.value} type="button" aria-pressed={origin === option.value} onClick={() => setOrigin(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="note">No connections yet. Use “Find connections”, or select an idea and add one yourself.</p>
            ) : (
              <ul aria-label="Connections">
                {shown.map((relation) => (
                  <li key={relation.id}>
                    <button type="button" className="rel" style={{ gridTemplateColumns: "34px minmax(0, 1fr) auto" }} aria-pressed={selection?.type === "edge" && selection.id === relation.id} onClick={() => select({ type: "edge", id: relation.id })}>
                      <RelationSwatch kind={relation.kind} />
                      <span className="rt">
                        {titleOf(relation.sourceObjectId)} <em style={{ color: `var(--rel-${relation.kind})` }}>{RELATION_LABELS[relation.kind]}</em> {titleOf(relation.targetObjectId)}
                      </span>
                      <span className="rv" title={ORIGIN_LABELS[relation.origin]}>
                        <OriginDot relation={relation} />
                        {ORIGIN_LABELS[relation.origin]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <aside className="inspector" aria-label="Connection details">
        {edge ? (
          <>
            <div className="insp-head">
              <div className="meta">
                <span className="kindname">Connection</span>
                <span aria-hidden="true">·</span>
                <span>{isSymmetricRelationKind(edge.kind) ? "No direction" : "Directional"}</span>
              </div>
              <h2 style={{ fontSize: 23 }}>
                {titleOf(edge.sourceObjectId)} <em style={{ color: `var(--rel-${edge.kind})` }}>{RELATION_LABELS[edge.kind]}</em> {titleOf(edge.targetObjectId)}
              </h2>
            </div>
            <section className="sec" style={{ marginTop: 22 }} aria-label="Ends">
              <div className="edge-hero">
                {[edge.sourceObjectId, edge.targetObjectId].map((id, position) => {
                  const object = byId.get(id);
                  return (
                    <div key={id}>
                      {position === 1 && (
                        <div className="edge-mid">
                          <RelationSwatch kind={edge.kind} width={44} />
                          <b>{RELATION_LABELS[edge.kind]}</b>
                        </div>
                      )}
                      <button type="button" className="edge-end" onClick={() => select({ type: "node", id })}>
                        {object && <KindGlyph kind={object.kind} />}
                        {titleOf(id)}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="sec" aria-labelledby="means-heading">
              <div className="sec-h">
                <h3 id="means-heading">What this means</h3>
              </div>
              <p className="note">{RELATION_MEANINGS[edge.kind]}</p>
            </section>
            <section className="sec" aria-labelledby="origin-heading">
              <div className="sec-h">
                <h3 id="origin-heading">Origin</h3>
              </div>
              <dl className="kv">
                <dt>Created by</dt>
                <dd>
                  <OriginDot relation={edge} />
                  {ORIGIN_LABELS[edge.origin]}
                </dd>
                <dt>Created</dt>
                <dd>
                  <time dateTime={edge.createdAt}>{formatMoment(edge.createdAt)}</time>
                </dd>
                <dt>Direction</dt>
                <dd>{isSymmetricRelationKind(edge.kind) ? `${titleOf(edge.sourceObjectId)} ↔ ${titleOf(edge.targetObjectId)} (no direction)` : `${titleOf(edge.sourceObjectId)} → ${titleOf(edge.targetObjectId)}`}</dd>
              </dl>
              {edge.origin === "model" && <p className="note" style={{ marginTop: 12 }}>Arthur proposed this link and checked it twice before saving it. Nothing here changes your ideas.</p>}
            </section>
          </>
        ) : node ? (
          <>
            <div className="insp-head">
              <div className="meta">
                <KindGlyph kind={node.kind} />
                <span className="kindname">{KIND_LABELS[node.kind]}</span>
              </div>
              <h2>{node.title}</h2>
            </div>
            <p className="insp-body clamp">{node.body}</p>
            <div className="insp-actions">
              <button type="button" className="btn" onClick={() => go("ideas", node.id)}>
                Open idea <Icon name="arrow" small />
              </button>
              <button type="button" className="btn ghost" onClick={() => go("evolution", node.id)}>
                <Icon name="rev" small />
                {byObject.get(node.id)?.revisionCount ?? 1} {(byObject.get(node.id)?.revisionCount ?? 1) === 1 ? "revision" : "revisions"}
              </button>
            </div>
            <section className="sec" style={{ marginTop: 22 }} aria-labelledby="node-connections-heading">
              <div className="sec-h">
                <h3 id="node-connections-heading">Connections</h3>
                <span className="n">{index.countOf(node.id)}</span>
                <button type="button" className="link" onClick={() => void infer([node.id])} disabled={inferring || objects.length < 2}>
                  Find for this idea
                </button>
              </div>
              {index.countOf(node.id) === 0 && <p className="note">No connections yet.</p>}
              {RELATION_KINDS.map((kind) => {
                const mine = index.edgesOf(node.id).filter((relation) => relation.kind === kind);
                if (mine.length === 0) return null;
                return (
                  <div key={kind}>
                    <div className="group-h">
                      <RelationSwatch kind={kind} />
                      <span>{RELATION_LABELS[kind]}</span>
                    </div>
                    {mine.map((relation) => {
                      const other = byId.get(relation.sourceObjectId === node.id ? relation.targetObjectId : relation.sourceObjectId);
                      if (!other) return null;
                      return (
                        <button key={relation.id} type="button" className="rel" style={{ gridTemplateColumns: "22px minmax(0, 1fr) auto" }} onClick={() => select({ type: "edge", id: relation.id })} aria-label={`${other.title}, ${relationVerbFrom(relation, node.id)}`}>
                          <KindGlyph kind={other.kind} />
                          <span className="rt">{other.title}</span>
                          <span className="rv" title={ORIGIN_LABELS[relation.origin]}>
                            <OriginDot relation={relation} />
                            {relationVerbFrom(relation, node.id)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </section>
            {objects.length >= 2 && (
              <section className="sec" aria-labelledby="add-heading">
                <div className="sec-h">
                  <h3 id="add-heading">Add a connection</h3>
                </div>
                <ConnectForm key={node.id} from={node} others={objects.filter((object) => object.id !== node.id)} creating={creating} onCreate={(kind, targetId) => create({ kind, sourceObjectId: node.id, targetObjectId: targetId })} />
              </section>
            )}
          </>
        ) : (
          <div className="state">
            <h2>Pick something on the map</h2>
            <p>Select an idea to see what it connects to, or a line to see how and why two ideas are linked.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
