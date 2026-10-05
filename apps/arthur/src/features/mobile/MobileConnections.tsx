import { useMemo, useState } from "react";
import { RELATION_KINDS, type CognitiveRelation, type CognitiveRelationKind, type KnowledgeObject } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { Icon, KIND_LABELS, KindGlyph } from "../../components/icons";
import { RelationSwatch } from "../../components/RelationArt";
import { relativeAge } from "../../components/format";
import { useGraphState } from "../graph/graph-context";
import { useRelationIndex } from "../graph/relation-index";
import { RELATION_LABELS, isDirectional, relationVerbFrom } from "../graph/relation-style";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useLineageSummaries } from "../lineage/lineage-summaries";
import { useProjects } from "../projects/projects-context";
import { EdgeSheet } from "./EdgeSheet";
import { SettingsButton } from "./MobileApp";
import { MobileMap, type MapSelection } from "./MobileMap";
import { MobileSheet } from "./MobileSheet";
import { useMobileNav } from "./mobile-nav";

type OriginFilter = "all" | "yours" | "arthur";
const ORIGINS: { value: OriginFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "yours", label: "Yours" },
  { value: "arthur", label: "Arthur’s" },
];
const matchesOrigin = (relation: CognitiveRelation, filter: OriginFilter): boolean => filter === "all" || (filter === "yours" ? relation.origin === "user" : relation.origin !== "user");

function FilterSheet({ origin, setOrigin, enabled, toggle, reset, onClose }: { origin: OriginFilter; setOrigin: (value: OriginFilter) => void; enabled: ReadonlySet<CognitiveRelationKind>; toggle: (kind: CognitiveRelationKind) => void; reset: () => void; onClose: () => void }) {
  return (
    <MobileSheet label="Show connections" onClose={onClose}>
      <div className="m-sbody">
        <h2>Show connections</h2>
        <h3 className="m-sec-t">Made by</h3>
        <div className="m-origin-filter" role="group" aria-label="Show links by origin">
          {ORIGINS.map((option) => (
            <button key={option.value} type="button" className="m-chip txt" aria-pressed={origin === option.value} onClick={() => setOrigin(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <h3 className="m-sec-t">
          Kind <span className="m-n">The line shape is the kind. Tap to hide or show.</span>
        </h3>
        <ul role="group" aria-label="Relation types">
          {RELATION_KINDS.map((kind) => (
            <li key={kind}>
              <button type="button" className={enabled.has(kind) ? "m-kindrow" : "m-kindrow off"} aria-pressed={enabled.has(kind)} onClick={() => toggle(kind)}>
                <RelationSwatch kind={kind} width={52} />
                <span>
                  <span className="m-rt sans">{RELATION_LABELS[kind]}</span>
                  <span className="m-rv">{isDirectional({ kind }) ? "Has a direction" : "No direction"}</span>
                </span>
                <span className="m-check" aria-hidden="true">
                  {enabled.has(kind) && <Icon name="check" small />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="m-sbar" data-hold-layout>
        <button type="button" className="m-pbtn" onClick={reset}>
          Show all
        </button>
        <button type="button" className="m-pbtn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </MobileSheet>
  );
}

export function MobileConnections() {
  const { objects, status: knowledgeStatus } = useKnowledge();
  const { status, inferring, notice, error, infer } = useGraphState();
  const { byObject } = useLineageSummaries();
  const index = useRelationIndex();
  const { focusId, focus } = useNavigation();
  const { connectionsView: view, setConnectionsView: setView, openIdea } = useMobileNav();
  const { switchTo } = useProjects();

  const [selection, setSelection] = useState<MapSelection>(focusId && view === "map" ? { type: "node", id: focusId } : null);
  const [openHubs, setOpenHubs] = useState<ReadonlySet<string>>(new Set(focusId ? [focusId] : []));
  const [enabled, setEnabled] = useState<ReadonlySet<CognitiveRelationKind>>(new Set(RELATION_KINDS));
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [filtering, setFiltering] = useState(false);
  const [edgeSheet, setEdgeSheet] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const byId = useMemo(() => new Map(objects.map((object) => [object.id, object])), [objects]);
  // The far ends of cross-project relations are drawn too, marked with their project. Nothing else from other projects is.
  const nodes = useMemo(() => [...objects, ...index.external], [objects, index.external]);
  const externals = useMemo(() => new Map(index.external.map((far) => [far.id, far.projectName])), [index.external]);
  const shown = useMemo(() => index.usable.filter((relation) => enabled.has(relation.kind) && matchesOrigin(relation, origin)), [index.usable, enabled, origin]);
  const activeFilters = (enabled.size < RELATION_KINDS.length ? 1 : 0) + (origin !== "all" ? 1 : 0);

  const hubs = useMemo(() => {
    const counted = objects
      .map((object) => ({ object, edges: shown.filter((relation) => relation.sourceObjectId === object.id || relation.targetObjectId === object.id) }))
      .filter((entry) => entry.edges.length > 0);
    return counted.sort((a, b) => b.edges.length - a.edges.length || (byObject.get(b.object.id)?.updatedAt ?? b.object.createdAt).localeCompare(byObject.get(a.object.id)?.updatedAt ?? a.object.createdAt));
  }, [objects, shown, byObject]);
  const unconnected = objects.filter((object) => index.countOf(object.id) === 0).length;

  const toggleKind = (kind: CognitiveRelationKind) =>
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next.size === 0 ? new Set(RELATION_KINDS) : next;
    });
  const resetFilters = () => {
    setEnabled(new Set(RELATION_KINDS));
    setOrigin("all");
  };

  const node: KnowledgeObject | undefined = selection?.type === "node" ? byId.get(selection.id) : undefined;
  const farNode = selection?.type === "node" ? index.externalOf(selection.id) : undefined;
  const select = (next: MapSelection) => {
    setSelection(next);
    setExpanded(false);
    if (next?.type === "node") focus(next.id);
  };

  const relationRow = (relation: CognitiveRelation, viewpointId: string) => {
    const otherId = relation.sourceObjectId === viewpointId ? relation.targetObjectId : relation.sourceObjectId;
    const far = index.externalOf(otherId);
    const other = byId.get(otherId) ?? far;
    if (!other) return null;
    const verb = relationVerbFrom(relation, viewpointId);
    const arrow = isDirectional(relation) ? (relation.sourceObjectId === viewpointId ? "→ " : "← ") : "";
    return (
      <button key={relation.id} type="button" className="m-rel" aria-label={`${other.title}, ${verb}, ${relation.origin === "user" ? "yours" : "Arthur's"}`} onClick={() => (view === "map" ? select({ type: "edge", id: relation.id }) : setEdgeSheet(relation.id))}>
        <RelationSwatch kind={relation.kind} />
        <span>
          <span className="m-rt">
            {other.title}
            {far && <span className="m-proj-tag"> {far.projectName} ↗</span>}
          </span>
          <span className="m-rv">
            <span className={relation.origin === "model" ? "m-origin model" : "m-origin"} aria-hidden="true" />
            <b>
              {arrow}
              {verb}
            </b>
            <span> · {relation.origin === "user" ? "Yours" : "Arthur’s"}</span>
          </span>
        </span>
      </button>
    );
  };

  const empty = objects.length === 0 && knowledgeStatus === "ready";
  return (
    <div className="m-conn" data-screen="connections">
      <header className="m-head">
        <div className="m-head-text">
          <h1>Connections</h1>
          <p className="m-sub">
            {objects.length} {objects.length === 1 ? "idea" : "ideas"} · {index.usable.length} {index.usable.length === 1 ? "link" : "links"}
          </p>
        </div>
        <button type="button" className="m-iconbtn" aria-label="Find connections" title="Asks the model to propose links between your ideas" onClick={() => void infer()} disabled={inferring || objects.length < 2}>
          <Icon name="wand" />
        </button>
        <SettingsButton />
      </header>
      <div className="m-ctl">
        <div className="m-tog" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
            <Icon name="list" small />
            List
          </button>
          <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>
            <Icon name="graph" small />
            Map
          </button>
        </div>
        <button type="button" className={activeFilters > 0 ? "m-pbtn sm filtered" : "m-pbtn sm"} onClick={() => setFiltering(true)}>
          <Icon name="filter" small />
          Filter{activeFilters > 0 ? ` · ${activeFilters}` : ""}
        </button>
      </div>
      <div className="m-live" aria-live="polite">
        {inferring && <p role="status">Looking for connections…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="m-note-block err">
            {error}
          </p>
        )}
        {(status === "loading" || knowledgeStatus === "loading") && <p role="status">Loading connections…</p>}
      </div>

      {empty ? (
        <div className="m-state">
          <h2>Nothing to connect yet</h2>
          <p>Capture a thought. Once Arthur has organized it into ideas, they appear here.</p>
        </div>
      ) : view === "map" ? (
        <div className="m-mapframe">
          <MobileMap objects={nodes} externals={externals} relations={index.usable} shown={shown} selection={selection} onSelect={select} focusId={focusId} bottomInset={selection ? 150 : 0} />
        </div>
      ) : (
        <div className="m-scroll m-list-scroll" id="m-conn-list">
          {hubs.length === 0 ? (
            <p className="m-footnote">{index.usable.length === 0 ? "No connections yet. Use “Find connections”, or open an idea to see what it could link to." : "No connections match this filter."}</p>
          ) : (
            <ul aria-label="Connections">
              {hubs.map(({ object, edges }) => {
                const open = openHubs.has(object.id);
                return (
                  <li key={object.id} className="m-hub" data-open={open}>
                    <button
                      type="button"
                      className="m-hub-h"
                      aria-expanded={open}
                      aria-label={`${object.title}, ${edges.length} ${edges.length === 1 ? "connection" : "connections"}`}
                      onClick={() =>
                        setOpenHubs((current) => {
                          const next = new Set(current);
                          if (next.has(object.id)) next.delete(object.id);
                          else next.add(object.id);
                          return next;
                        })
                      }
                    >
                      <KindGlyph kind={object.kind} />
                      <span className="m-t">{object.title}</span>
                      <span className="m-cnt" aria-hidden="true">
                        {edges.length}
                      </span>
                      <span className="m-chev" aria-hidden="true">
                        <Icon name="chev" small />
                      </span>
                    </button>
                    {open && (
                      <div className="m-hub-b">
                        {edges.map((relation) => relationRow(relation, object.id))}
                        <button type="button" className="m-tlink" onClick={() => openIdea(object.id)}>
                          Open idea <Icon name="chev" small />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="m-footnote">
            {unconnected > 0 ? `${unconnected} ${unconnected === 1 ? "idea has" : "ideas have"} no connections yet.` : "Every idea here has at least one connection."} Each link shows under both of its ideas.
          </p>
        </div>
      )}

      {view === "map" && node && !edgeSheet && !filtering && (
        <MobileSheet label={node.title} onClose={() => select(null)} modal={false} aboveTabs>
          <div className="m-peek">
            <div className="m-pm">
              <KindGlyph kind={node.kind} />
              <span className="m-kindname">{KIND_LABELS[node.kind]}</span>
              <span>· {relativeAge(byObject.get(node.id)?.updatedAt ?? node.createdAt)}</span>
            </div>
            <p className="m-pt">{node.title}</p>
            <p className="m-pm">
              {index.countOf(node.id)} {index.countOf(node.id) === 1 ? "connection" : "connections"} · {byObject.get(node.id)?.revisionCount ?? 1} {(byObject.get(node.id)?.revisionCount ?? 1) === 1 ? "revision" : "revisions"}
            </p>
            {expanded && <div className="m-peek-list">{index.edgesOf(node.id).map((relation) => relationRow(relation, node.id))}</div>}
            <div className="m-pa">
              <button type="button" className="m-pbtn primary" onClick={() => openIdea(node.id)}>
                Open idea
              </button>
              <button type="button" className="m-pbtn" aria-expanded={expanded} onClick={() => setExpanded((now) => !now)} disabled={index.countOf(node.id) === 0}>
                {index.countOf(node.id)} {index.countOf(node.id) === 1 ? "connection" : "connections"}
                <span className={expanded ? "m-chev open" : "m-chev"}>
                  <Icon name="chev" small />
                </span>
              </button>
            </div>
          </div>
        </MobileSheet>
      )}
      {view === "map" && farNode && !edgeSheet && !filtering && (
        <MobileSheet label={farNode.title} onClose={() => select(null)} modal={false} aboveTabs>
          <div className="m-peek">
            <div className="m-pm">
              <KindGlyph kind={farNode.kind} />
              <span className="m-kindname">{KIND_LABELS[farNode.kind]}</span>
              <span>· In {farNode.projectName} ↗</span>
            </div>
            <p className="m-pt">{farNode.title}</p>
            <p className="m-pm">This idea belongs to another project. Only the connection reaches across.</p>
            {expanded && <div className="m-peek-list">{index.edgesOf(farNode.id).map((relation) => relationRow(relation, farNode.id))}</div>}
            <div className="m-pa">
              <button type="button" className="m-pbtn primary" onClick={() => void switchTo(farNode.projectId)}>
                Open {farNode.projectName}
              </button>
              <button type="button" className="m-pbtn" aria-expanded={expanded} onClick={() => setExpanded((now) => !now)}>
                {index.countOf(farNode.id)} {index.countOf(farNode.id) === 1 ? "connection" : "connections"}
                <span className={expanded ? "m-chev open" : "m-chev"}>
                  <Icon name="chev" small />
                </span>
              </button>
            </div>
          </div>
        </MobileSheet>
      )}
      {view === "map" && selection?.type === "edge" && !filtering && <EdgeSheet relationId={selection.id} modal={false} onClose={() => select(null)} onOpenIdea={openIdea} />}
      {edgeSheet && <EdgeSheet relationId={edgeSheet} modal onClose={() => setEdgeSheet(null)} onOpenIdea={(id) => { setEdgeSheet(null); openIdea(id); }} />}
      {filtering && <FilterSheet origin={origin} setOrigin={setOrigin} enabled={enabled} toggle={toggleKind} reset={resetFilters} onClose={() => setFiltering(false)} />}
    </div>
  );
}
