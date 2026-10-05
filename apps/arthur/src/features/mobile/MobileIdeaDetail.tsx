import { useMemo, useState } from "react";
import type { KnowledgeObject } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { Icon, KIND_LABELS, KindGlyph, SOURCE_LABELS, SourceIcon } from "../../components/icons";
import { Margin } from "../../components/Margin";
import { RelationSwatch } from "../../components/RelationArt";
import { SourceQuote } from "../../components/SourceQuote";
import { formatMoment, relativeAge } from "../../components/format";
import { useCaptures } from "../capture/captures-context";
import { useGraphState } from "../graph/graph-context";
import { useRelationIndex } from "../graph/relation-index";
import { ORIGIN_LABELS as RELATION_ORIGIN_LABELS, relationVerbFrom } from "../graph/relation-style";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useLineageSummaries } from "../lineage/lineage-summaries";
import { ORIGIN_LABELS, captionFor } from "../lineage/revision-captions";
import { useLineage } from "../lineage/use-lineage";
import { MobileRevisionForm } from "./MobileRevisionForm";
import { MobileSheet } from "./MobileSheet";
import { useMobileNav } from "./mobile-nav";
import { EdgeSheet } from "./EdgeSheet";

/** A full-screen page for one idea: its words, then the three facets of it (where from, what it connects to, how it changed). */
export function MobileIdeaDetail({ objectId }: { objectId: string }) {
  const { objects, refresh } = useKnowledge();
  const { captures } = useCaptures();
  const { byObject } = useLineageSummaries();
  const index = useRelationIndex();
  const { infer, inferring, notice: graphNotice, error: graphError } = useGraphState();
  const { go } = useNavigation();
  const { closePage, closeAllPages, setConnectionsView, openIdea } = useMobileNav();
  const object = objects.find((candidate) => candidate.id === objectId);
  const lineage = useLineage(objectId, null, refresh);
  const [sheet, setSheet] = useState<"revise" | "branch" | null>(null);
  const [edge, setEdge] = useState<string | null>(null);

  const summary = byObject.get(objectId);
  const byId = useMemo(() => new Map(objects.map((candidate) => [candidate.id, candidate])), [objects]);
  if (!object) {
    return (
      <div className="m-page" role="region" aria-label="Idea">
        <div className="m-page-top">
          <button type="button" className="m-iconbtn" aria-label="Back" onClick={closePage}>
            <Icon name="back" />
          </button>
        </div>
        <div className="m-state">
          <h2>This idea isn’t available</h2>
          <p>It may have been removed. Go back and choose another.</p>
        </div>
      </div>
    );
  }

  const capture = captures.find((candidate) => candidate.id === object.provenance.captureId);
  const edges = index.edgesOf(object.id);
  const revisions = summary?.lineage.revisions ?? [];
  const labels = new Map(revisions.map((revision, i) => [revision.id, `R${i + 1}`]));
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  const lastThree = revisions.slice(-3);
  const current = revisions.find((revision) => revision.id === summary?.lineage.currentRevisionId);
  const source = capture?.source ?? "text";

  const leaveTo = (screen: "connections" | "evolution", view?: "list" | "map") => {
    closeAllPages();
    if (view) setConnectionsView(view);
    go(screen, object.id);
  };

  return (
    <div className="m-page" role="region" aria-label={`Idea: ${object.title}`}>
      <div className="m-page-top">
        <button type="button" className="m-iconbtn" aria-label="Back" onClick={closePage}>
          <Icon name="back" />
        </button>
        <span className="m-spacer" />
        {edges.length > 0 && (
          <button type="button" className="m-iconbtn" aria-label="Show on map" onClick={() => leaveTo("connections", "map")}>
            <Icon name="graph" />
          </button>
        )}
      </div>
      <div className="m-scroll">
        <div className="m-d-head">
          <div className="m-d-meta">
            <KindGlyph kind={object.kind} />
            <span className="m-kindname">{KIND_LABELS[object.kind]}</span>
            <span aria-hidden="true">·</span>
            <span>Edited {relativeAge(summary?.updatedAt ?? object.createdAt)}</span>
          </div>
          <h1 className="m-d-title">{object.title}</h1>
        </div>
        <div className="m-d-margin">
          <Margin source={source} connections={edges.length} revisions={summary?.revisionCount} />
        </div>
        <p className="m-d-body">{object.body}</p>
        {lineage.notice && (
          <p role="status" className="m-d-notice">
            {lineage.notice}
          </p>
        )}

        <section className="m-facet" aria-labelledby="m-f-source">
          <div className="m-facet-h">
            <h2 id="m-f-source">Source</h2>
            <span className="m-n">where this came from</span>
          </div>
          {capture && (
            <p className="m-cap-meta2">
              <SourceIcon source={capture.source} />
              <span>
                {SOURCE_LABELS[capture.source]} capture · {formatMoment(capture.createdAt)}
              </span>
            </p>
          )}
          <div className="m-quote-wrap">
            <SourceQuote capture={capture} provenance={object.provenance} />
          </div>
        </section>

        <section className="m-facet" aria-labelledby="m-f-conn">
          <div className="m-facet-h">
            <h2 id="m-f-conn">Connections</h2>
            <span className="m-n">{edges.length}</span>
            {edges.length > 0 && (
              <button type="button" className="m-tlink end" onClick={() => leaveTo("connections", "map")}>
                Show on map <Icon name="chev" small />
              </button>
            )}
          </div>
          {edges.length === 0 ? (
            <p className="m-quiet">No connections yet. Arthur can look for some.</p>
          ) : (
            <ul>
              {edges.slice(0, 3).map((relation) => {
                const other = byId.get(relation.sourceObjectId === object.id ? relation.targetObjectId : relation.sourceObjectId);
                if (!other) return null;
                return (
                  <li key={relation.id}>
                    <button type="button" className="m-rel" aria-label={`${other.title}, ${relationVerbFrom(relation, object.id)}`} onClick={() => setEdge(relation.id)}>
                      <RelationSwatch kind={relation.kind} />
                      <span>
                        <span className="m-rt">{other.title}</span>
                        <span className="m-rv" title={RELATION_ORIGIN_LABELS[relation.origin]}>
                          <span className={relation.origin === "model" ? "m-origin model" : "m-origin"} aria-hidden="true" />
                          <b>{relationVerbFrom(relation, object.id)}</b>
                          <span> · {relation.origin === "user" ? "Yours" : "Arthur’s"}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {edges.length > 3 && (
            <button type="button" className="m-tlink" onClick={() => leaveTo("connections", "list")}>
              All {edges.length} connections <Icon name="chev" small />
            </button>
          )}
          <div>
            <button type="button" className="m-tlink" onClick={() => void infer([object.id])} disabled={inferring || objects.length < 2}>
              <Icon name="wand" small />
              {inferring ? "Finding…" : "Find connections for this idea"}
            </button>
          </div>
          {graphNotice && (
            <p role="status" className="m-quiet">
              {graphNotice}
            </p>
          )}
          {graphError && (
            <p role="alert" className="m-note-block err">
              {graphError}
            </p>
          )}
        </section>

        <section className="m-facet" aria-labelledby="m-f-evo">
          <div className="m-facet-h">
            <h2 id="m-f-evo">Evolution</h2>
            <span className="m-n">
              {summary?.revisionCount ?? 1} {(summary?.revisionCount ?? 1) === 1 ? "revision" : "revisions"}
            </span>
            {(summary?.revisionCount ?? 1) > 1 && (
              <button type="button" className="m-tlink end" onClick={() => leaveTo("evolution")}>
                Open <Icon name="chev" small />
              </button>
            )}
          </div>
          {summary && revisions.length > 1 ? (
            <ul className="m-minirail" aria-label="Revisions">
              {revisions.length > 3 && (
                <li className="m-mr more">
                  <span className="m-b">…</span>
                  <span className="m-x">{revisions.length - 3} earlier</span>
                </li>
              )}
              {lastThree.map((revision) => {
                const isCurrent = revision.id === summary.lineage.currentRevisionId;
                return (
                  <li key={revision.id} className={isCurrent ? "m-mr cur" : "m-mr"}>
                    <span className="m-b">{labels.get(revision.id)}</span>
                    <span className="m-x">
                      {ORIGIN_LABELS[revision.origin]}
                      <small>
                        {captionFor(revision, revisionById, (id) => labels.get(id) ?? "R?")} · {relativeAge(revision.createdAt)}
                        {isCurrent ? " · current" : ""}
                      </small>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-quiet">One version so far. Revise it and Arthur keeps both.</p>
          )}
        </section>
      </div>
      <div className="m-actbar">
        <button type="button" className="m-pbtn primary" onClick={() => setSheet("revise")} disabled={!current}>
          <Icon name="edit" />
          Revise
        </button>
        <button type="button" className="m-pbtn" onClick={() => setSheet("branch")} disabled={!current}>
          <Icon name="branch" />
          Branch
        </button>
      </div>

      {sheet && current && (
        <RevisionSheet
          mode={sheet}
          object={object}
          currentLabel={labels.get(current.id) ?? "R1"}
          nextLabel={`R${revisions.length + 1}`}
          base={current}
          busy={lineage.busy}
          error={lineage.error}
          onClose={() => setSheet(null)}
          onSubmit={async (changes) => {
            const done = sheet === "revise" ? await lineage.edit(changes) : await lineage.branch(current.id, changes);
            if (done) setSheet(null);
            return done;
          }}
        />
      )}
      {edge && <EdgeSheet relationId={edge} modal onClose={() => setEdge(null)} onOpenIdea={(id) => {
          setEdge(null);
          if (id !== object.id) openIdea(id);
        }} />}
    </div>
  );
}

function RevisionSheet({
  mode,
  object,
  base,
  currentLabel,
  nextLabel,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  mode: "revise" | "branch";
  object: KnowledgeObject;
  base: { kind: KnowledgeObject["kind"]; title: string; body: string };
  currentLabel: string;
  nextLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (changes: import("@arthur/contracts").RevisionChanges) => Promise<boolean>;
}) {
  const formId = `m-rev-${mode}`;
  const branch = mode === "branch";
  return (
    <MobileSheet label={branch ? "Branch" : "Revise"} onClose={onClose}>
      <div className="m-sbody">
        <h2>{branch ? `Branch from ${currentLabel}` : "Revise this idea"}</h2>
        <p className="m-sheet-note">
          {branch ? `Starts a second line of thought from ${currentLabel}. The current revision stays ${currentLabel}.` : `Saves as ${nextLabel} and makes it current. ${currentLabel} stays exactly as it is.`}
        </p>
        <MobileRevisionForm formId={formId} key={object.id + mode} base={base} onSubmit={(changes) => onSubmit(changes)} />
        {error && (
          <p role="alert" className="m-note-block err">
            {error}
          </p>
        )}
      </div>
      <div className="m-sbar" data-hold-layout>
        <button type="button" className="m-pbtn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" form={formId} className="m-pbtn primary" disabled={busy}>
          {busy ? "Saving…" : branch ? `Create branch ${nextLabel}` : `Save as ${nextLabel}`}
        </button>
      </div>
    </MobileSheet>
  );
}
