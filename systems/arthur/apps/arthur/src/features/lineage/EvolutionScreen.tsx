import { useEffect, useMemo, useState } from "react";
import type { DiffSegment, RevisionDiff, ThoughtRevision } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { Icon, KIND_LABELS, SOURCE_LABELS, SourceIcon } from "../../components/icons";
import { SourceQuote } from "../../components/SourceQuote";
import { formatMoment, relativeAge } from "../../components/format";
import { useCaptures } from "../capture/captures-context";
import { useKnowledge } from "../knowledge/knowledge-context";
import { LineageRail, LineageSketch } from "./LineageRail";
import { RevisionForm } from "./RevisionForm";
import { useLineageSummaries, useObjectLineage } from "./lineage-summaries";
import { captionFor, statsFromDiff } from "./revision-captions";
import { originLabel, originTag, provenanceNote, useApprovals } from "../review/use-approvals";
import { useLineage } from "./use-lineage";
import "./lineage.css";
import "./evolution.css";

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

type Mode = null | "revise" | "branch" | "merge";

/** The history shape in the picker. Read lazily; an idea that was never edited needs no read. */
function PickerSketch({ objectId }: { objectId: string }) {
  const lineage = useObjectLineage(objectId);
  return lineage ? <LineageSketch revisions={lineage.revisions} currentRevisionId={lineage.currentRevisionId} /> : <span aria-hidden="true" style={{ width: 104, height: 14, display: "inline-block" }} />;
}

function History({ objectId, title }: { objectId: string; title: string }) {
  const { refresh } = useKnowledge();
  const { captures } = useCaptures();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { status, lineage, diffs, busy, notice, error, edit, branch, merge, restore } = useLineage(objectId, selectedId, refresh);
  const approvals = useApprovals(objectId, lineage?.currentRevisionId);
  const [mode, setMode] = useState<Mode>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [makeMergeCurrent, setMakeMergeCurrent] = useState(true);
  const [compareId, setCompareId] = useState<string | null>(null);

  const revisions = lineage?.revisions ?? [];
  const labelOf = (id: string): string => `R${revisions.findIndex((revision) => revision.id === id) + 1}`;
  const byId = useMemo(() => new Map(revisions.map((revision) => [revision.id, revision])), [revisions]);
  const current = revisions.find((revision) => revision.id === lineage?.currentRevisionId);
  const selected: ThoughtRevision | undefined = revisions.find((revision) => revision.id === selectedId) ?? current;
  const pickedRevisions = revisions.filter((revision) => picked.includes(revision.id));

  useEffect(() => {
    setCompareId(null);
  }, [selected?.id]);

  if (status === "loading" || !lineage || !current || !selected) {
    return (
      <div className="state" role={status === "error" ? undefined : "status"}>
        {status === "error" ? (
          error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )
        ) : (
          <>
            <div className="skel" style={{ height: 24, width: "50%" }} />
            <p>Loading history…</p>
          </>
        )}
      </div>
    );
  }

  const children = new Map<string, number>();
  for (const revision of revisions) for (const parentId of revision.parentRevisionIds) children.set(parentId, (children.get(parentId) ?? 0) + 1);
  const branches = [...children.values()].reduce((sum, n) => sum + (n > 1 ? n - 1 : 0), 0);
  const merges = revisions.filter((revision) => revision.parentRevisionIds.length > 1).length;

  const isCurrent = selected.id === lineage.currentRevisionId;
  const parents = selected.parentRevisionIds.map((id) => byId.get(id)).filter((revision): revision is ThoughtRevision => revision !== undefined);
  const compare = parents.find((parent) => parent.id === compareId) ?? parents[0];
  const diff: RevisionDiff | undefined = compare ? diffs.get(compare.id) : undefined;
  const stats = diff ? statsFromDiff(diff) : null;
  const capture = selected.provenance ? captures.find((candidate) => candidate.id === selected.provenance?.captureId) : undefined;

  function toggle(id: string) {
    setPicked((now) => (now.includes(id) ? now.filter((existing) => existing !== id) : [...now, id]));
  }
  function chooseMode(next: Mode) {
    setMode(next === mode ? null : next);
    setPicked([]);
  }

  return (
    <>
      <div className="head">
        <div>
          <h2>{title}</h2>
          <p>
            {revisions.length} {revisions.length === 1 ? "revision" : "revisions"} · {branches} {branches === 1 ? "branch" : "branches"} · {merges} {merges === 1 ? "merge" : "merges"} · <span className="current-note">{labelOf(current.id)} is current</span>
          </p>
        </div>
        <span className="spacer" />
        <button type="button" className="btn" aria-pressed={mode === "revise"} onClick={() => chooseMode("revise")}>
          <Icon name="edit" small />
          Revise
        </button>
        <button type="button" className="btn ghost" aria-pressed={mode === "branch"} onClick={() => chooseMode("branch")}>
          <Icon name="branch" small />
          Branch from {labelOf(selected.id)}
        </button>
        {selected.id !== current.id && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void restore(selected.id)} title="Adds a new revision with this text. Nothing is deleted.">
            <Icon name="retry" small />
            Undo to {labelOf(selected.id)}
          </button>
        )}
        <button type="button" className="btn ghost" aria-pressed={mode === "merge"} onClick={() => chooseMode("merge")} disabled={revisions.length < 2}>
          <Icon name="merge" small />
          Merge…
        </button>
      </div>

      {(notice || error) && (
        <div className="tools" style={{ paddingTop: 10 }}>
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="rail-wrap">
        <LineageRail
          revisions={revisions}
          currentRevisionId={lineage.currentRevisionId}
          selectedRevisionId={selected.id}
          picked={mode === "merge" ? picked : []}
          tags={new Map([...approvals].map(([id, approval]) => [id, originTag({ origin: "system" }, approval)]))}
          onSelect={(id) => (mode === "merge" ? toggle(id) : setSelectedId(id))}
        />
      </div>

      {mode === "revise" && (
        <section className="mode-panel" aria-label="Revise">
          <h3>Revise</h3>
          <p className="note" style={{ marginBottom: 10 }}>
            Saves a new revision after {labelOf(current.id)} and makes it current. Nothing is overwritten.
          </p>
          <RevisionForm
            key={`revise-${current.id}`}
            label="Revise this idea"
            base={current}
            submitLabel="Save revision"
            busy={busy}
            onCancel={() => setMode(null)}
            onSubmit={async (changes) => {
              const done = await edit(changes);
              if (done) setMode(null);
              return done;
            }}
          />
        </section>
      )}
      {mode === "branch" && (
        <section className="mode-panel" aria-label="Branch">
          <h3>Branch from {labelOf(selected.id)}</h3>
          <p className="note" style={{ marginBottom: 10 }}>
            Starts a second line of thought from this revision. The current revision stays {labelOf(current.id)}.
          </p>
          <RevisionForm
            key={`branch-${selected.id}`}
            label="Branch from the selected revision"
            base={selected}
            submitLabel={`Branch from ${labelOf(selected.id)}`}
            busy={busy}
            onCancel={() => setMode(null)}
            onSubmit={async (changes) => {
              const done = await branch(selected.id, changes);
              if (done) setMode(null);
              return done;
            }}
          />
        </section>
      )}
      {mode === "merge" && (
        <section className="mode-panel" aria-label="Merge">
          <h3>Merge</h3>
          {pickedRevisions.length < 2 ? (
            <p className="note">Select two or more revisions on the rail to merge them into a new one.</p>
          ) : (
            <>
              <label className="check" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input type="checkbox" checked={makeMergeCurrent} onChange={(event) => setMakeMergeCurrent(event.target.checked)} /> Make the merge the current revision
              </label>
              <RevisionForm
                key={`merge-${pickedRevisions.map((revision) => revision.id).join("+")}`}
                label="Merge the selected revisions"
                base={pickedRevisions[pickedRevisions.length - 1] as ThoughtRevision}
                submitLabel={`Merge ${pickedRevisions.map((revision) => labelOf(revision.id)).join(" + ")}`}
                busy={busy}
                allowUnchanged
                onCancel={() => chooseMode(null)}
                onSubmit={async (_changes, full) => {
                  const done = await merge(
                    pickedRevisions.map((revision) => revision.id),
                    full,
                    makeMergeCurrent,
                  );
                  if (done) {
                    setPicked([]);
                    setMode(null);
                  }
                  return done;
                }}
              />
            </>
          )}
        </section>
      )}

      <div className="detail" aria-label="Selected revision">
        <div>
          <div className="dh">
            <h3>Revision {labelOf(selected.id)}</h3>
            <small>
              {originLabel(selected, approvals.get(selected.id))} · <time dateTime={selected.createdAt}>{formatMoment(selected.createdAt)}</time>
            </small>
            {isCurrent && <small style={{ color: "var(--accent)" }}>Current</small>}
            <span className="spacer" />
            {parents.length > 1 && (
              <div className="tabbtn" role="group" aria-label="Compare with">
                {parents.map((parent) => (
                  <button key={parent.id} type="button" className={parent.id === compare?.id ? "btn" : "btn ghost"} style={{ height: 26 }} aria-pressed={parent.id === compare?.id} onClick={() => setCompareId(parent.id)}>
                    vs {labelOf(parent.id)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {compare && diff ? (
            <>
              <div className="stat" aria-label={`Changes from ${labelOf(compare.id)} to ${labelOf(selected.id)}`}>
                <span>
                  Changes from <b>{labelOf(compare.id)}</b>
                </span>
                {stats && <span className="a">+{stats.added} words</span>}
                {stats && <span className="d">−{stats.removed} words</span>}
                <span>{diff.title.changed ? "Title changed" : "Title unchanged"}</span>
                <span>{diff.kind.changed ? `Kind: ${KIND_LABELS[diff.kind.from]} → ${KIND_LABELS[diff.kind.to]}` : "Kind unchanged"}</span>
              </div>
              <div className="diffbox diff">
                <div aria-label="Title changes">
                  <span className="dl">Title</span>
                  <div style={{ fontSize: 21, lineHeight: 1.3 }}>{diff.title.changed ? <Segments segments={diff.title.segments} /> : selected.title}</div>
                </div>
                <div aria-label="Body changes">
                  <span className="dl">Body</span>
                  {diff.body.changed ? <Segments segments={diff.body.segments} /> : selected.body}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="stat">
                <span>{parents.length === 0 ? "First version of this idea" : "Loading changes…"}</span>
              </div>
              <div className="diffbox diff">
                <div>
                  <span className="dl">Title</span>
                  <div style={{ fontSize: 21, lineHeight: 1.3 }}>{selected.title}</div>
                </div>
                <div>
                  <span className="dl">Body</span>
                  {selected.body}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="sidecol">
          <section className="sec" aria-labelledby="rev-source-heading">
            <div className="sec-h">
              <h3 id="rev-source-heading">Source</h3>
            </div>
            {selected.provenance ? (
              <>
                {capture && (
                  <p className="cap-meta">
                    <SourceIcon source={capture.source} />
                    <span>
                      {SOURCE_LABELS[capture.source]} capture · {formatMoment(capture.createdAt)}
                    </span>
                  </p>
                )}
                <SourceQuote capture={capture} provenance={selected.provenance} />
              </>
            ) : (
              <p className="note">{provenanceNote(selected, approvals.get(selected.id)) ?? (selected.origin === "merge" ? "Merged text is written by you. Arthur never says it came from a capture." : "This text is your edit, so it has no capture source.")}</p>
            )}
          </section>
          <section className="sec" aria-labelledby="parents-heading">
            <div className="sec-h">
              <h3 id="parents-heading">{parents.length > 1 ? "Merged from" : "Continues from"}</h3>
            </div>
            {parents.length === 0 ? (
              <p className="note">Nothing. This is where the idea starts.</p>
            ) : (
              <ul>
                {parents.map((parent) => (
                  <li key={parent.id}>
                    <button type="button" className="rel" style={{ gridTemplateColumns: "34px minmax(0, 1fr) auto" }} onClick={() => mode !== "merge" && setSelectedId(parent.id)}>
                      <b style={{ fontWeight: 650 }}>{labelOf(parent.id)}</b>
                      <span className="rt" style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--ink-2)" }}>
                        {captionFor(parent, byId, labelOf)}
                      </span>
                      <span className="rv">{relativeAge(parent.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export function EvolutionScreen() {
  const { objects, status, error } = useKnowledge();
  const { byObject } = useLineageSummaries();
  const { focusId, focus, openCapture } = useNavigation();

  const ordered = useMemo(
    () =>
      [...objects].sort((a, b) => {
        const ra = byObject.get(a.id)?.revisionCount ?? 1;
        const rb = byObject.get(b.id)?.revisionCount ?? 1;
        if ((ra > 1) !== (rb > 1)) return ra > 1 ? -1 : 1; // ideas with a real history first
        return (byObject.get(b.id)?.updatedAt ?? b.createdAt).localeCompare(byObject.get(a.id)?.updatedAt ?? a.createdAt);
      }),
    [objects, byObject],
  );
  const chosen = ordered.find((object) => object.id === focusId) ?? ordered[0];

  return (
    <div className="evolution">
      <nav className="picker" aria-label="Ideas with history">
        <h1>Evolution</h1>
        <p>How ideas change over time</p>
        {status === "error" && error && (
          <p role="alert" className="alert" style={{ margin: "0 22px" }}>
            {error}
          </p>
        )}
        <ul>
          {ordered.map((object) => {
            const summary = byObject.get(object.id);
            return (
              <li key={object.id}>
                <button type="button" className={(summary?.revisionCount ?? 1) > 1 ? "pick" : "pick single"} aria-pressed={chosen?.id === object.id} onClick={() => focus(object.id)}>
                  <span className="t">{object.title}</span>
                  {summary && <PickerSketch objectId={object.id} />}
                  <span className="m">
                    {summary ? `r${summary.revisionCount} · ${relativeAge(summary.updatedAt)}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section className="work" aria-label="Revision history">
        {status === "loading" && (
          <div className="state" role="status">
            <div className="skel" style={{ height: 24, width: "50%" }} />
            <p>Loading ideas…</p>
          </div>
        )}
        {status === "ready" && !chosen && (
          <div className="state">
            <h2>No history yet</h2>
            <p>Every idea starts with one revision, and each edit adds another. Capture a thought to begin.</p>
            <button type="button" className="btn primary" onClick={openCapture}>
              Capture a thought
            </button>
          </div>
        )}
        {chosen && <History key={chosen.id} objectId={chosen.id} title={chosen.title} />}
      </section>
    </div>
  );
}
