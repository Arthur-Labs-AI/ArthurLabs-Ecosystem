import { useId, useState } from "react";
import type { CognitiveEvidence, EvidenceHistoryEntry, EvidenceSource } from "@arthur/contracts";
import { Icon, KIND_LABELS, KindGlyph } from "../../components/icons";
import { formatMoment } from "../../components/format";
import { ORIGIN_LABELS } from "../lineage/revision-captions";
import { STATE_LABELS, actionsFor, includedBecause, isKind, isWeak, markLabel, sourceView, type EvidenceIndex } from "./evidence-model";
import type { EvidenceTarget } from "./use-evidence-nav";

/**
 * One piece of evidence, as a margin note: what it is, whether it is current, which project it comes from, why it is here, where
 * it was first written, and how it got to its present wording. Shared by Desktop (inline, in the margin column) and Mobile (in a
 * sheet). No score, id or token count ever appears here.
 */

const ORIGIN_WORDS = ORIGIN_LABELS as Record<string, string | undefined>;

export function KindLine({ entry }: { entry: CognitiveEvidence }) {
  return (
    <span className="ev-kind">
      {isKind(entry.kind) ? <KindGlyph kind={entry.kind} /> : null}
      <span>{isKind(entry.kind) ? KIND_LABELS[entry.kind] : entry.kind}</span>
    </span>
  );
}

/** The state chips of an entry: current or superseded, from another project, weak, edited since capture. Words, not colour. */
export function StateChips({ entry }: { entry: CognitiveEvidence }) {
  return (
    <span className="ev-chips">
      <span className="ev-chip" data-state={entry.status}>
        {STATE_LABELS[entry.status]}
      </span>
      {entry.externalProject && (
        <span className="ev-chip" data-state="external" title={`This comes from ${entry.projectName}`}>
          {entry.projectName} <span aria-hidden="true">↗</span>
          <span className="visually-hidden"> (another project)</span>
        </span>
      )}
      {isWeak(entry) && (
        <span className="ev-chip" data-state="weak">
          Weak match
        </span>
      )}
      {entry.provenance?.editedSinceCapture && (
        <span className="ev-chip" data-state="edited">
          Edited since capture
        </span>
      )}
    </span>
  );
}

/** The exact words of the capture an entry came from, behind "View source". Never claims the capture holds edited wording. */
export function SourcePanel({ source, edited, label = "View source" }: { source: EvidenceSource; edited: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const view = sourceView(source);
  return (
    <div className="ev-source">
      <button type="button" className="ev-link" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((now) => !now)}>
        {open ? "Hide source" : label}
      </button>
      {open && (
        <div id={panel} className="ev-source-body">
          <p className="ev-source-meta">
            {view.sourceLabel} · {formatMoment(view.when)}
          </p>
          {view.excerpt !== null ? (
            <blockquote className="quote" aria-label="Original capture text">
              {view.excerpt}
              {view.truncated ? "…" : ""}
            </blockquote>
          ) : (
            <p className="note">The exact words aren’t shown here. Open the original capture to read them.</p>
          )}
          {edited && <p className="ev-edited">This idea was edited after it was captured, so the capture may not contain its current wording.</p>}
        </div>
      )}
    </div>
  );
}

function HistoryEntry({ past, entry }: { past: EvidenceHistoryEntry; entry: CognitiveEvidence }) {
  const marks = past.marks.map(markLabel).filter((mark): mark is string => mark !== null);
  const origin = ORIGIN_WORDS[past.origin];
  return (
    <li className="ev-past" data-state={past.status} id={`ev-${past.handle.replace(".", "-")}`}>
      <div className="ev-past-head">
        <span className="ev-chip" data-state={past.status}>
          {STATE_LABELS[past.status]}
        </span>
        <span className="ev-past-meta">
          {past.handle} · {formatMoment(past.createdAt)}
          {origin ? ` · ${origin}` : ""}
        </span>
      </div>
      <p className="ev-past-title">{past.title}</p>
      <p className="ev-past-body">
        {past.body}
        {past.truncated ? "…" : ""}
      </p>
      {marks.length > 0 && <p className="ev-past-marks">{marks.join(" · ")}</p>}
      {past.source && <SourcePanel source={past.source} edited={false} label="View source of this version" />}
      {!past.leadsToCurrent && past.status === "branch_not_current" && <p className="ev-past-marks">This line was never made the current version of {entry.title}.</p>}
    </li>
  );
}

export function EvidenceDetail({ entry, index, onOpen, showBody = true }: { entry: CognitiveEvidence; index: EvidenceIndex; onOpen: (target: EvidenceTarget, entry: CognitiveEvidence) => void; showBody?: boolean }) {
  const because = includedBecause(entry, index);
  const actions = actionsFor(entry);
  const origin = entry.provenance?.origin ?? null;
  const past = entry.lineage?.entries ?? [];
  const where = entry.externalProject ? ` in ${entry.projectName}` : "";
  return (
    <div className="ev-detail">
      {showBody && <p className="ev-body">{entry.currentBody}</p>}
      {because.length > 0 && (
        <div className="ev-because">
          <b>Included because</b>
          <ul>
            {because.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {origin && <SourcePanel source={origin} edited={entry.provenance?.editedSinceCapture ?? false} />}
      {past.length > 0 && (
        <section className="ev-history" aria-label={`Earlier versions of ${entry.title}`}>
          <b>Earlier versions</b>
          <ul>
            {past.map((one) => (
              <HistoryEntry key={one.handle} past={one} entry={entry} />
            ))}
          </ul>
        </section>
      )}
      <div className="ev-actions" role="group" aria-label={`Open ${entry.title}`}>
        <button type="button" className="btn ev-btn" onClick={() => onOpen("idea", entry)}>
          <Icon name="ideas" small />
          Open idea{where}
        </button>
        {actions.capture && (
          <button type="button" className="btn ev-btn" onClick={() => onOpen("capture", entry)}>
            <Icon name="text" small />
            Open original capture
          </button>
        )}
        {actions.evolution && (
          <button type="button" className="btn ev-btn" onClick={() => onOpen("evolution", entry)}>
            <Icon name="evolution" small />
            Open in Evolution
          </button>
        )}
        {actions.connections && (
          <button type="button" className="btn ev-btn" onClick={() => onOpen("connections", entry)}>
            <Icon name="connections" small />
            Open in Connections
          </button>
        )}
        {actions.project && (
          <button type="button" className="btn ev-btn" onClick={() => onOpen("project", entry)}>
            <Icon name="chev" small />
            Open {entry.projectName}
          </button>
        )}
      </div>
    </div>
  );
}
