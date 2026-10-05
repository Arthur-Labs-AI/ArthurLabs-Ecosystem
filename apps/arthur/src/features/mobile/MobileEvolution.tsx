import { useEffect, useMemo, useState } from "react";
import type { DiffSegment, KnowledgeObjectKind, RevisionChanges, ThoughtRevision } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { Icon, KIND_LABELS, KindGlyph, SOURCE_LABELS, SourceIcon } from "../../components/icons";
import { SourceQuote } from "../../components/SourceQuote";
import { formatMoment, relativeAge } from "../../components/format";
import { useCaptures } from "../capture/captures-context";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useLineageSummaries } from "../lineage/lineage-summaries";
import { ORIGIN_LABELS, captionFor, statsFromDiff } from "../lineage/revision-captions";
import { useLineage } from "../lineage/use-lineage";
import { layoutVerticalLineage, type VerticalEdge } from "../lineage/vertical-layout";
import { SettingsButton } from "./MobileApp";
import { MobileRevisionForm } from "./MobileRevisionForm";
import { MobileSheet } from "./MobileSheet";
import { useMobileNav } from "./mobile-nav";

const LANE_W = 34;
const NODE_TOP = 17;
const NODE_H = 26;
const CURVE = 30;

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

type Sheet = null | "revise" | "branch" | "merge" | "pick";

function History({ objectId }: { objectId: string }) {
  const { refresh } = useKnowledge();
  const { captures } = useCaptures();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { status, lineage, diffs, busy, notice, error, edit, branch, merge } = useLineage(objectId, selectedId, refresh);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [makeMergeCurrent, setMakeMergeCurrent] = useState(true);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [tab, setTab] = useState<"changes" | "full">("changes");

  const revisions = lineage?.revisions ?? [];
  const layout = useMemo(() => layoutVerticalLineage(revisions), [revisions]);
  const byId = useMemo(() => new Map(revisions.map((revision) => [revision.id, revision])), [revisions]);
  const labelOf = (id: string): string => `R${revisions.findIndex((revision) => revision.id === id) + 1}`;
  const current = revisions.find((revision) => revision.id === lineage?.currentRevisionId);
  const selected = revisions.find((revision) => revision.id === selectedId);

  useEffect(() => {
    setCompareId(null);
    setTab("changes");
  }, [selectedId]);

  if (status === "loading" || !lineage || !current) {
    return (
      <div className="m-state" role={status === "error" ? undefined : "status"}>
        {status === "error" ? (
          error && (
            <p role="alert" className="m-note-block err">
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

  const railWidth = 22 + (layout.lanes - 1) * LANE_W + 24;
  const x = (lane: number): number => 22 + lane * LANE_W;
  const touches = (edge: VerticalEdge): boolean => selectedId !== null && (edge.parentId === selectedId || edge.childId === selectedId);
  const nextLabel = `R${revisions.length + 1}`;

  const pickedRevisions = revisions.filter((revision) => picked.includes(revision.id));

  return (
    <>
      <p className="m-evo-sum">
        {revisions.length} {revisions.length === 1 ? "revision" : "revisions"}
        {layout.branches > 0 && ` · ${layout.branches} ${layout.branches === 1 ? "branch" : "branches"}`}
        {layout.merges > 0 && ` · ${layout.merges} ${layout.merges === 1 ? "merge" : "merges"}`} · <b>{labelOf(current.id)} is current</b>
      </p>
      <p className="m-evo-help">Every edit keeps the old version. Branch to try another direction, merge to bring them back together.</p>
      <div className="m-evo-acts">
        <button type="button" className="m-pbtn" onClick={() => setSheet("revise")}>
          <Icon name="edit" />
          Revise
        </button>
        <button
          type="button"
          className="m-pbtn"
          disabled={revisions.length < 2}
          onClick={() => {
            setPicked(revisions.filter((revision) => revision.parentRevisionIds.length < 2).slice(-2).map((revision) => revision.id));
            setSheet("merge");
          }}
        >
          <Icon name="merge" />
          Merge…
        </button>
      </div>
      {notice && (
        <p role="status" className="m-live-note">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="m-note-block err">
          {error}
        </p>
      )}

      <ol className="m-vrail" aria-label="Revisions, oldest first">
        {layout.revisions.map((entry) => {
          const revision = byId.get(entry.id) as ThoughtRevision;
          const isCurrent = revision.id === lineage.currentRevisionId;
          const isSelected = revision.id === selectedId;
          const lines: { key: string; left: number; style: Record<string, number | string>; cls: string }[] = [];
          const curves: { key: string; left: number; width: number; flip: boolean; where: "top" | "bottom"; cls: string }[] = [];
          for (const edge of layout.edges) {
            const cls = `${byId.get(edge.childId)!.parentRevisionIds.length > 1 ? "m " : ""}${touches(edge) ? "sel" : ""}`;
            const { fromRow, toRow, fromLane, toLane, kind } = edge;
            const key = `${edge.parentId}>${edge.childId}`;
            if (entry.row < fromRow || entry.row > toRow) continue;
            if (kind === "straight") {
              if (entry.row === fromRow) lines.push({ key, left: x(fromLane), style: { top: NODE_TOP + NODE_H, bottom: 0 }, cls });
              else if (entry.row < toRow) lines.push({ key, left: x(fromLane), style: { top: 0, bottom: 0 }, cls });
              else lines.push({ key, left: x(toLane), style: { top: 0, height: NODE_TOP }, cls });
            } else if (kind === "branch") {
              if (entry.row === fromRow) {
                lines.push({ key: `${key}-a`, left: x(fromLane), style: { top: NODE_TOP + NODE_H, bottom: CURVE }, cls });
                curves.push({ key, left: Math.min(x(fromLane), x(toLane)), width: Math.abs(x(toLane) - x(fromLane)), flip: toLane < fromLane, where: "bottom", cls });
              } else if (entry.row < toRow) lines.push({ key, left: x(toLane), style: { top: 0, bottom: 0 }, cls });
              else lines.push({ key, left: x(toLane), style: { top: 0, height: NODE_TOP }, cls });
            } else if (entry.row === fromRow) lines.push({ key, left: x(fromLane), style: { top: NODE_TOP + NODE_H, bottom: 0 }, cls });
            else if (entry.row < toRow) lines.push({ key, left: x(fromLane), style: { top: 0, bottom: 0 }, cls });
            else curves.push({ key, left: Math.min(x(fromLane), x(toLane)), width: Math.abs(x(toLane) - x(fromLane)), flip: toLane > fromLane ? false : true, where: "top", cls });
          }
          const sel = isSelected ? revision : null;
          return (
            <li key={revision.id} className="m-vrow" style={{ ["--rail-w" as string]: `${railWidth}px` }}>
              <div className="m-vcell" aria-hidden="true">
                {lines.map((line) => (
                  <span key={line.key} className={`m-vln ${line.cls}`} style={{ left: line.left, ...line.style }} />
                ))}
                {curves.map((curve) => (
                  <svg key={curve.key} className="m-vsvg" style={curve.where === "bottom" ? { left: curve.left, bottom: 0, width: curve.width, height: CURVE } : { left: curve.left, top: 0, width: curve.width, height: NODE_TOP }} viewBox={`0 0 ${curve.width} ${curve.where === "bottom" ? CURVE : NODE_TOP}`}>
                    <path className={curve.cls} d={curve.where === "bottom" ? `M${curve.flip ? curve.width : 0} 0 C${curve.flip ? curve.width : 0} ${CURVE * 0.62},${curve.flip ? 0 : curve.width} ${CURVE * 0.4},${curve.flip ? 0 : curve.width} ${CURVE}` : `M${curve.flip ? 0 : curve.width} 0 C${curve.flip ? 0 : curve.width} ${NODE_TOP * 0.6},${curve.flip ? curve.width : 0} ${NODE_TOP * 0.3},${curve.flip ? curve.width : 0} ${NODE_TOP}`} />
                  </svg>
                ))}
                {revision.parentRevisionIds.length > 0 && <span className="m-varrow" style={{ left: x(entry.lane) }} />}
                <span className={`m-vnode o-${revision.origin}${revision.origin === "merge" ? " merge" : ""}${isCurrent ? " cur" : ""}${isSelected ? " sel" : ""}`} style={{ left: x(entry.lane) }}>
                  {entry.label}
                </span>
              </div>
              <div className="m-vtxt">
                <button type="button" className="m-vhit" aria-expanded={isSelected} aria-label={`Revision ${entry.label}, ${ORIGIN_LABELS[revision.origin]}${isCurrent ? ", current" : ""}`} onClick={() => setSelectedId(isSelected ? null : revision.id)}>
                  <span className="m-l1">
                    {ORIGIN_LABELS[revision.origin]}
                    {isCurrent && <span className="m-tag cur">Current</span>}
                  </span>
                  <span className="m-l2">
                    {captionFor(revision, byId, labelOf)} · {relativeAge(revision.createdAt)}
                  </span>
                </button>
                {sel && (
                  <Expanded
                    revision={sel}
                    labelOf={labelOf}
                    byId={byId}
                    diffs={diffs}
                    compareId={compareId}
                    setCompareId={setCompareId}
                    tab={tab}
                    setTab={setTab}
                    capture={sel.provenance ? captures.find((candidate) => candidate.id === sel.provenance?.captureId) : undefined}
                    onBranch={() => setSheet("branch")}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {sheet === "revise" && (
        <FormSheet label="Revise" title="Revise this idea" note={`Saves as ${nextLabel} and makes it current. ${labelOf(current.id)} stays exactly as it is.`} submitLabel={`Save as ${nextLabel}`} busy={busy} error={error} base={current} onClose={() => setSheet(null)} onSubmit={async (changes) => {
          const done = await edit(changes);
          if (done) setSheet(null);
          return done;
        }} />
      )}
      {sheet === "branch" && selected && (
        <FormSheet label="Branch" title={`Branch from ${labelOf(selected.id)}`} note={`Starts a second line of thought from ${labelOf(selected.id)}. The current revision stays ${labelOf(current.id)}.`} submitLabel={`Create branch ${nextLabel}`} busy={busy} error={error} base={selected} onClose={() => setSheet(null)} onSubmit={async (changes) => {
          const done = await branch(selected.id, changes);
          if (done) setSheet(null);
          return done;
        }} />
      )}
      {sheet === "merge" && (
        <FormSheet
          label="Merge"
          title="Merge revisions"
          note="Pick two or more. You write the merged text. Arthur never merges for you."
          submitLabel={pickedRevisions.length >= 2 ? `Merge ${pickedRevisions.map((revision) => labelOf(revision.id)).join(" + ")}` : "Pick two or more"}
          disabled={pickedRevisions.length < 2}
          busy={busy}
          error={error}
          base={(pickedRevisions[pickedRevisions.length - 1] ?? current) as ThoughtRevision}
          allowUnchanged
          formKey={pickedRevisions.map((revision) => revision.id).join("+")}
          onClose={() => setSheet(null)}
          extra={
            <>
              <div className="m-cmp" role="group" aria-label="Revisions to merge">
                {revisions.map((revision) => (
                  <button key={revision.id} type="button" className="m-chip" aria-pressed={picked.includes(revision.id)} onClick={() => setPicked((now) => (now.includes(revision.id) ? now.filter((id) => id !== revision.id) : [...now, revision.id]))}>
                    {labelOf(revision.id)}
                  </button>
                ))}
              </div>
              <label className="m-check-row">
                <input type="checkbox" checked={makeMergeCurrent} onChange={(event) => setMakeMergeCurrent(event.target.checked)} /> Make the merge the current revision
              </label>
            </>
          }
          onSubmit={async (_changes, full) => {
            const done = await merge(pickedRevisions.map((revision) => revision.id), full as { kind: KnowledgeObjectKind; title: string; body: string }, makeMergeCurrent);
            if (done) {
              setPicked([]);
              setSheet(null);
            }
            return done;
          }}
        />
      )}
    </>
  );
}

function FormSheet({
  label,
  title,
  note,
  submitLabel,
  busy,
  error,
  base,
  onClose,
  onSubmit,
  allowUnchanged = false,
  disabled = false,
  extra,
  formKey,
}: {
  label: string;
  title: string;
  note: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  base: { kind: KnowledgeObjectKind; title: string; body: string };
  onClose: () => void;
  onSubmit: (changes: RevisionChanges, full: { kind: KnowledgeObjectKind; title: string; body: string }) => Promise<boolean>;
  allowUnchanged?: boolean;
  disabled?: boolean;
  extra?: React.ReactNode;
  formKey?: string;
}) {
  const formId = `m-form-${label.toLowerCase()}`;
  return (
    <MobileSheet label={label} onClose={onClose}>
      <div className="m-sbody">
        <h2>{title}</h2>
        <p className="m-sheet-note">{note}</p>
        {extra}
        <MobileRevisionForm key={formKey ?? label} formId={formId} base={base} allowUnchanged={allowUnchanged} onSubmit={onSubmit} />
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
        <button type="submit" form={formId} className="m-pbtn primary" disabled={busy || disabled}>
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </MobileSheet>
  );
}

function Expanded({
  revision,
  labelOf,
  byId,
  diffs,
  compareId,
  setCompareId,
  tab,
  setTab,
  capture,
  onBranch,
}: {
  revision: ThoughtRevision;
  labelOf: (id: string) => string;
  byId: ReadonlyMap<string, ThoughtRevision>;
  diffs: ReadonlyMap<string, import("@arthur/contracts").RevisionDiff>;
  compareId: string | null;
  setCompareId: (id: string) => void;
  tab: "changes" | "full";
  setTab: (tab: "changes" | "full") => void;
  capture: import("@arthur/contracts").Capture | undefined;
  onBranch: () => void;
}) {
  const parents = revision.parentRevisionIds.map((id) => byId.get(id)).filter((candidate): candidate is ThoughtRevision => candidate !== undefined);
  const compare = parents.find((parent) => parent.id === compareId) ?? parents[0];
  const diff = compare ? diffs.get(compare.id) : undefined;
  const stats = diff ? statsFromDiff(diff) : null;
  const showFull = tab === "full" || !compare;

  return (
    <div className="m-vexp" aria-label={`Revision ${labelOf(revision.id)}`}>
      <p className="m-vmeta">
        {ORIGIN_LABELS[revision.origin]} · <time dateTime={revision.createdAt}>{formatMoment(revision.createdAt)}</time>
        {revision.kind && <span> · {KIND_LABELS[revision.kind]}</span>}
      </p>
      {parents.length > 1 && (
        <div className="m-cmp" role="group" aria-label="Compare with">
          <span>Compared with</span>
          {parents.map((parent) => (
            <button key={parent.id} type="button" className="m-chip" aria-pressed={parent.id === compare?.id} onClick={() => setCompareId(parent.id)}>
              {labelOf(parent.id)}
            </button>
          ))}
        </div>
      )}
      {parents.length === 1 && compare && <p className="m-cmp">Compared with <b>{labelOf(compare.id)}</b></p>}
      {compare && (
        <div className="m-dtabs" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>
            Changes
          </button>
          <button type="button" aria-pressed={tab === "full"} onClick={() => setTab("full")}>
            Full text
          </button>
        </div>
      )}
      {stats && !showFull && (
        <p className="m-stat" aria-label={`Changes from ${labelOf(compare!.id)} to ${labelOf(revision.id)}`}>
          <span className="a">+{stats.added} words</span> <span className="d">−{stats.removed} words</span> · {diff!.title.changed ? "Title changed" : "Title unchanged"}
          {diff!.kind.changed ? ` · Kind: ${KIND_LABELS[diff!.kind.from]} → ${KIND_LABELS[diff!.kind.to]}` : ""}
        </p>
      )}
      <div className="m-diff" aria-live="polite">
        {!compare ? (
          <>
            <span className="m-dl">Title</span>
            <div className="m-dtitle">{revision.title}</div>
            <span className="m-dl">Text</span>
            {revision.body}
            <p className="m-vnote">This is the first version, so there is nothing earlier to compare with.</p>
          </>
        ) : showFull ? (
          <>
            <span className="m-dl">Title</span>
            <div className="m-dtitle">{revision.title}</div>
            <span className="m-dl">Text</span>
            {revision.body}
          </>
        ) : diff ? (
          <>
            <span className="m-dl">Title</span>
            <div className="m-dtitle">{diff.title.changed ? <Segments segments={diff.title.segments} /> : revision.title}</div>
            <span className="m-dl">Text</span>
            {diff.body.changed ? <Segments segments={diff.body.segments} /> : revision.body}
          </>
        ) : (
          <p role="status">Loading changes…</p>
        )}
      </div>
      {revision.provenance ? (
        <div className="m-vsrc">
          {capture && (
            <p className="m-cap-meta2">
              <SourceIcon source={capture.source} />
              <span>
                {SOURCE_LABELS[capture.source]} capture · {formatMoment(capture.createdAt)}
              </span>
            </p>
          )}
          <div className="m-quote-wrap">
            <SourceQuote capture={capture} provenance={revision.provenance} />
          </div>
        </div>
      ) : (
        <p className="m-vnote">{revision.origin === "merge" ? "Merged text is written by you. Arthur never says it came from a capture." : revision.origin === "initial" ? "" : "This text is your edit, so it has no capture source."}</p>
      )}
      <button type="button" className="m-pbtn sm" onClick={onBranch}>
        <Icon name="branch" small />
        Branch from {labelOf(revision.id)}
      </button>
    </div>
  );
}

export function MobileEvolution() {
  const { objects, status, error } = useKnowledge();
  const { byObject } = useLineageSummaries();
  const { focusId, focus } = useNavigation();
  const { capture } = useMobileNav();
  const [picking, setPicking] = useState(false);

  const ordered = useMemo(
    () =>
      [...objects].sort((a, b) => {
        const ra = byObject.get(a.id)?.revisionCount ?? 1;
        const rb = byObject.get(b.id)?.revisionCount ?? 1;
        if (ra > 1 !== rb > 1) return ra > 1 ? -1 : 1;
        return (byObject.get(b.id)?.updatedAt ?? b.createdAt).localeCompare(byObject.get(a.id)?.updatedAt ?? a.createdAt);
      }),
    [objects, byObject],
  );
  const chosen = ordered.find((object) => object.id === focusId) ?? ordered[0];

  return (
    <div className="m-evo" data-screen="evolution">
      <header className="m-head">
        <div className="m-head-text">
          <h1>Evolution</h1>
        </div>
        <SettingsButton />
      </header>
      <div className="m-scroll m-evo-scroll">
        {status === "error" && error && (
          <p role="alert" className="m-note-block err">
            {error}
          </p>
        )}
        {status === "loading" && (
          <div className="m-state" role="status">
            <div className="skel" style={{ height: 24, width: "50%" }} />
            <p>Loading ideas…</p>
          </div>
        )}
        {status === "ready" && !chosen && (
          <div className="m-state">
            <h2>No history yet</h2>
            <p>Every idea starts with one revision, and each edit adds another. Capture a thought to begin.</p>
            <button type="button" className="m-pbtn primary" onClick={capture}>
              Capture a thought
            </button>
          </div>
        )}
        {chosen && (
          <>
            <button type="button" className="m-evo-pick" aria-label={`Choose an idea. Now: ${chosen.title}`} onClick={() => setPicking(true)}>
              <KindGlyph kind={chosen.kind} />
              <span className="m-t">{chosen.title}</span>
              <span className="m-chev down" aria-hidden="true">
                <Icon name="chev" />
              </span>
            </button>
            <History key={chosen.id} objectId={chosen.id} />
          </>
        )}
      </div>
      {picking && (
        <MobileSheet label="Choose an idea" onClose={() => setPicking(false)}>
          <div className="m-sbody">
            <h2>Choose an idea</h2>
            <p className="m-sheet-note">Ideas with a history come first.</p>
            <ul>
              {ordered.map((object) => {
                const summary = byObject.get(object.id);
                return (
                  <li key={object.id}>
                    <button
                      type="button"
                      className="m-idea flat"
                      aria-pressed={chosen?.id === object.id}
                      onClick={() => {
                        focus(object.id);
                        setPicking(false);
                      }}
                    >
                      <KindGlyph kind={object.kind} />
                      <span className="m-idea-text">
                        <span className="m-t">{object.title}</span>
                        <span className="m-s one">{summary ? `r${summary.revisionCount} · ${relativeAge(summary.updatedAt)}` : ""}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </MobileSheet>
      )}
    </div>
  );
}
