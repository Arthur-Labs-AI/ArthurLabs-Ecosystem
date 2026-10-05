import { useEffect, useMemo, useRef, useState } from "react";
import { KNOWLEDGE_OBJECT_KINDS, type KnowledgeObject, type KnowledgeObjectKind } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { BOUND } from "../../app/shortcuts";
import { Icon, KIND_LABELS, KIND_PLURALS, KindGlyph, SOURCE_LABELS, SourceIcon } from "../../components/icons";
import { Margin } from "../../components/Margin";
import { RelationSwatch } from "../../components/RelationArt";
import { SourceQuote } from "../../components/SourceQuote";
import { dayLabel, formatMoment, relativeAge } from "../../components/format";
import { useCaptures } from "../capture/captures-context";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useRelationIndex } from "../graph/relation-index";
import { useKnowledge } from "../knowledge/knowledge-context";
import { RevisionForm } from "../lineage/RevisionForm";
import { useLineageSummaries, useObjectLineage } from "../lineage/lineage-summaries";
import { useLineage } from "../lineage/use-lineage";
import { ORIGIN_LABELS, captionFor } from "../lineage/revision-captions";
import { ORIGIN_LABELS as RELATION_ORIGIN_LABELS, relationVerbFrom } from "../graph/relation-style";
import "./ideas.css";

function IdeaInspector({ object }: { object: KnowledgeObject }) {
  const { captures } = useCaptures();
  const { refresh } = useKnowledge();
  const { byObject } = useLineageSummaries();
  const index = useRelationIndex();
  const { objects } = useKnowledge();
  const { go, focus } = useNavigation();
  const [revising, setRevising] = useState(false);
  const { busy, notice, error, edit } = useLineage(object.id, null, refresh);

  // Leaving one idea for another closes the form: a half-written revision belongs to the idea it was started on.
  useEffect(() => setRevising(false), [object.id]);

  const summary = byObject.get(object.id);
  const lineage = useObjectLineage(object.id);
  const capture = captures.find((candidate) => candidate.id === object.provenance.captureId);
  const edges = index.edgesOf(object.id);
  const byId = useMemo(() => new Map(objects.map((candidate) => [candidate.id, candidate])), [objects]);
  const neighbourhood = useMemo(() => {
    const ids = new Set([object.id, ...edges.flatMap((relation) => [relation.sourceObjectId, relation.targetObjectId])]);
    return { objects: objects.filter((candidate) => ids.has(candidate.id)), relations: edges };
  }, [object.id, edges, objects]);
  const revisions = lineage ? [...lineage.revisions].reverse() : [];
  const labels = new Map((lineage?.revisions ?? []).map((revision, i) => [revision.id, `R${i + 1}`]));
  const revisionById = new Map((lineage?.revisions ?? []).map((revision) => [revision.id, revision]));

  return (
    <aside className="inspector" aria-label="Idea details">
      <div className="insp-head">
        <div className="meta">
          <KindGlyph kind={object.kind} />
          <span className="kindname">{KIND_LABELS[object.kind]}</span>
          <span aria-hidden="true">·</span>
          <span>Edited {relativeAge(summary?.updatedAt ?? object.createdAt)}</span>
        </div>
        <h2>{object.title}</h2>
      </div>

      {revising ? (
        <div className="sec" style={{ marginTop: 16, borderTop: 0 }}>
          <RevisionForm
            key={object.id}
            label="Revise this idea"
            base={object}
            submitLabel="Save revision"
            busy={busy}
            onCancel={() => setRevising(false)}
            onSubmit={async (changes) => {
              const done = await edit(changes);
              if (done) setRevising(false);
              return done;
            }}
          />
          {error && (
            <p role="alert" className="alert" style={{ marginTop: 10 }}>
              {error}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="insp-body">{object.body}</p>
          <div className="insp-actions">
            <button type="button" className="btn" onClick={() => setRevising(true)}>
              <Icon name="edit" small />
              Revise
            </button>
          </div>
          {notice && (
            <p role="status" className="note" style={{ padding: "10px 26px 0" }}>
              {notice}
            </p>
          )}
        </>
      )}

      <section className="sec" aria-labelledby="source-heading">
        <div className="sec-h">
          <h3 id="source-heading">Source</h3>
        </div>
        {capture && (
          <p className="cap-meta">
            <SourceIcon source={capture.source} />
            <span>
              {SOURCE_LABELS[capture.source]} capture · {formatMoment(capture.createdAt)}
            </span>
          </p>
        )}
        <SourceQuote capture={capture} provenance={object.provenance} />
      </section>

      <section className="sec" aria-labelledby="connections-heading">
        <div className="sec-h">
          <h3 id="connections-heading">Connections</h3>
          <span className="n">{edges.length}</span>
          <button type="button" className="link" onClick={() => go("connections", object.id)}>
            Open in Connections <Icon name="arrow" />
          </button>
        </div>
        {edges.length === 0 ? (
          <p className="note">No connections yet.</p>
        ) : (
          <>
            <div className="ego-frame">
              <GraphCanvas objects={neighbourhood.objects} relations={neighbourhood.relations} scale="mini" label={`Connections around ${object.title}`} />
            </div>
            <ul>
              {edges.map((relation) => {
                const other = byId.get(relation.sourceObjectId === object.id ? relation.targetObjectId : relation.sourceObjectId);
                if (!other) return null;
                return (
                  <li key={relation.id}>
                    <button type="button" className="rel" onClick={() => focus(other.id)} aria-label={`${other.title}, ${relationVerbFrom(relation, object.id)}`}>
                      <RelationSwatch kind={relation.kind} />
                      <span className="rt">{other.title}</span>
                      <span className="rv" title={RELATION_ORIGIN_LABELS[relation.origin]}>
                        <span className={relation.origin === "model" ? "origin model" : "origin"} aria-hidden="true" />
                        {relationVerbFrom(relation, object.id)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="sec" aria-labelledby="revisions-heading">
        <div className="sec-h">
          <h3 id="revisions-heading">Revisions</h3>
          <span className="n">{summary?.revisionCount ?? ""}</span>
          <button type="button" className="link" onClick={() => go("evolution", object.id)}>
            Open in Evolution <Icon name="arrow" />
          </button>
        </div>
        {lineage && (
          <ul className="spine" aria-label="Revisions">
            {revisions.map((revision) => {
              const current = revision.id === lineage.currentRevisionId;
              return (
                <li key={revision.id}>
                  <div className={current ? "rv-row cur" : "rv-row"}>
                    <i aria-hidden="true" />
                    <b>{labels.get(revision.id)}</b>
                    <span>
                      {current ? "Current · " : ""}
                      {captionFor(revision, revisionById, (id) => labels.get(id) ?? "R?")}
                    </span>
                    <em title={ORIGIN_LABELS[revision.origin]}>{relativeAge(revision.createdAt)}</em>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}

export function IdeasScreen() {
  const { objects, status, error } = useKnowledge();
  const { byObject } = useLineageSummaries();
  const index = useRelationIndex();
  const { focusId, focus, openCapture } = useNavigation();
  const [kind, setKind] = useState<KnowledgeObjectKind | "all">("all");
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (event.key === BOUND.focusSearch && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        search.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const updatedAt = (object: KnowledgeObject): string => byObject.get(object.id)?.updatedAt ?? object.createdAt;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      objects
        .filter((object) => (kind === "all" || object.kind === kind) && (needle === "" || `${object.title}\n${object.body}`.toLowerCase().includes(needle)))
        .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a))),
    [objects, kind, needle, byObject],
  );
  const selected = visible.find((object) => object.id === focusId) ?? visible[0];

  let lastDay = "";
  return (
    <div className="ideas">
      <div className="lcol">
        <div className="page-head">
          <div>
            <h1>Ideas</h1>
            <p>What Arthur organized from your captures</p>
          </div>
        </div>
        <div className="toolbar">
          <label className="input" style={{ flex: 1, maxWidth: 380 }}>
            <Icon name="search" small />
            <input ref={search} placeholder="Search ideas" aria-label="Search ideas" value={query} onChange={(event) => setQuery(event.target.value)} />
            <kbd>/</kbd>
          </label>
        </div>
        <div className="tabs">
          <div className="seg" role="group" aria-label="Filter by kind">
            <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
              All<i>{objects.length}</i>
            </button>
            {KNOWLEDGE_OBJECT_KINDS.map((option) => {
              const count = objects.filter((object) => object.kind === option).length;
              return (
                <button key={option} type="button" className={count === 0 ? "zero" : ""} aria-pressed={kind === option} onClick={() => setKind(option)}>
                  {KIND_PLURALS[option]}
                  <i>{count}</i>
                </button>
              );
            })}
          </div>
        </div>

        <div className="scroll">
          {status === "loading" && (
            <div className="state" role="status" aria-label="Loading ideas">
              <div className="skel" style={{ height: 18, width: "55%" }} />
              <div className="skel" style={{ height: 12, width: "90%" }} />
              <div className="skel" style={{ height: 12, width: "75%" }} />
              <p>Loading ideas…</p>
            </div>
          )}
          {status === "error" && error && (
            <p role="alert" className="alert" style={{ margin: 24 }}>
              {error}
            </p>
          )}
          {status === "ready" && objects.length === 0 && (
            <div className="state">
              <h2>No ideas yet</h2>
              <p>Capture a thought and Arthur organizes it into ideas, tasks, decisions and questions, each pointing back at your exact words.</p>
              <button type="button" className="btn primary" onClick={openCapture}>
                Capture a thought
              </button>
            </div>
          )}
          {status === "ready" && objects.length > 0 && visible.length === 0 && (
            <div className="state">
              <h2>Nothing matches</h2>
              <p>No idea matches that search and filter.</p>
            </div>
          )}
          <ul className="list" aria-label="Ideas">
            {visible.map((object) => {
              const day = dayLabel(updatedAt(object));
              const heading = day !== lastDay ? day : null;
              lastDay = day;
              const capture = object.provenance.captureId;
              return (
                <li key={object.id}>
                  {heading && <div className="day">{heading}</div>}
                  <button type="button" className="row" aria-pressed={selected?.id === object.id} onClick={() => focus(object.id)} data-capture={capture}>
                    <KindGlyph kind={object.kind} />
                    <span className="text">
                      <span className="t" style={{ display: "block" }}>
                        {object.title}
                      </span>
                      <span className="s" style={{ display: "block" }}>
                        {object.body}
                      </span>
                    </span>
                    <SourceMargin object={object} connections={index.countOf(object.id)} revisions={byObject.get(object.id)?.revisionCount} age={relativeAge(updatedAt(object))} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {selected ? (
        <IdeaInspector key={selected.id} object={selected} />
      ) : (
        <aside className="inspector" aria-label="Idea details">
          <div className="state">
            <h2>Select an idea</h2>
            <p>Its words, where it came from, what it connects to and how it changed appear here.</p>
          </div>
        </aside>
      )}
    </div>
  );
}

/** Looks up the capture's source kind for the margin, without needing the captures list in the row. */
function SourceMargin({ object, connections, revisions, age }: { object: KnowledgeObject; connections: number; revisions: number | undefined; age: string }) {
  const { captures } = useCaptures();
  const source = captures.find((capture) => capture.id === object.provenance.captureId)?.source ?? "text";
  return <Margin source={source} connections={connections} revisions={revisions} age={age} />;
}

