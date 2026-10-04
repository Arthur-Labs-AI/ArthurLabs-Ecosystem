import { useMemo, type KeyboardEvent } from "react";
import type { ThoughtRevision } from "@arthur/contracts";
import { formatMoment } from "../../components/format";
import { REVISION_HEIGHT, REVISION_WIDTH, layoutLineage } from "./lineage-layout";
import { ORIGIN_TAGS, captionFor } from "./revision-captions";
import "./lineage.css";

function activate(action: () => void) {
  return (event: KeyboardEvent<SVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}

/**
 * One object's revision DAG as a rail: time runs left to right, the line of thought is lane 0 and branches take lanes
 * below it. Arrows run from a parent to the revision that continues it, so two rails into one box is a merge and two
 * rails out of one is a branch. Revisions are rounded rectangles, never circles: this must not read as the graph.
 * `picked` marks revisions chosen for a merge.
 */
export function LineageRail({
  revisions,
  currentRevisionId,
  selectedRevisionId,
  picked = [],
  onSelect,
}: {
  revisions: readonly ThoughtRevision[];
  currentRevisionId: string;
  selectedRevisionId: string;
  picked?: readonly string[];
  onSelect: (revisionId: string) => void;
}) {
  const layout = useMemo(() => layoutLineage(revisions), [revisions]);
  const byId = useMemo(() => new Map(revisions.map((revision) => [revision.id, revision])), [revisions]);
  const labelOf = (id: string): string => layout.nodes.get(id)?.label ?? "R?";

  return (
    <div className="rail-scroll">
      <svg className="lineage" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Revision history">
        <defs>
          <marker id="lineage-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M1 1.5 8.5 5 1 8.5z" fill="var(--ink-3)" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const touched = edge.parentId === selectedRevisionId || edge.childId === selectedRevisionId;
          const merge = (byId.get(edge.childId)?.parentRevisionIds.length ?? 0) > 1;
          return <path key={edge.id} className={`l-edge${touched ? " selected" : ""}${merge ? " merge" : ""}`} d={edge.path} markerEnd="url(#lineage-arrow)" />;
        })}

        {revisions.map((revision) => {
          const node = layout.nodes.get(revision.id);
          if (!node) return null;
          const current = revision.id === currentRevisionId;
          const selected = revision.id === selectedRevisionId;
          const isPicked = picked.includes(revision.id);
          const select = () => onSelect(revision.id);
          return (
            <g
              key={revision.id}
              className={`l-node origin-${revision.origin}${current ? " current" : ""}${selected ? " selected" : ""}${isPicked ? " picked" : ""}`}
              transform={`translate(${node.x},${node.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Revision ${node.label}${current ? " (current)" : ""}`}
              aria-pressed={selected || isPicked}
              onClick={select}
              onKeyDown={activate(select)}
            >
              {(selected || isPicked) && <rect className="l-halo" x={-REVISION_WIDTH / 2 - 5} y={-REVISION_HEIGHT / 2 - 5} width={REVISION_WIDTH + 10} height={REVISION_HEIGHT + 10} rx={9} />}
              <rect className="l-box" x={-REVISION_WIDTH / 2} y={-REVISION_HEIGHT / 2} width={REVISION_WIDTH} height={REVISION_HEIGHT} rx={7} />
              {revision.origin === "merge" && <path className="l-mergebar" d={`M${-REVISION_WIDTH / 2 + 6} ${REVISION_HEIGHT / 2 - 6}h${REVISION_WIDTH - 12}`} />}
              <text className="l-id" y={4.5} textAnchor="middle">
                {node.label}
              </text>
              <text className="l-tag" y={-REVISION_HEIGHT / 2 - 9} textAnchor="middle">
                {current ? "current" : ORIGIN_TAGS[revision.origin]}
              </text>
              <text className="l-cap" y={REVISION_HEIGHT / 2 + 19} textAnchor="middle">
                {captionFor(revision, byId, labelOf)}
              </text>
              <text className="l-when" y={REVISION_HEIGHT / 2 + 35} textAnchor="middle">
                {formatMoment(revision.createdAt)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A tiny, label-free rail that shows an idea's real shape (linear, branched, merged). For lists. */
export function LineageSketch({ revisions, currentRevisionId }: { revisions: readonly ThoughtRevision[]; currentRevisionId: string }) {
  const layout = useMemo(() => layoutLineage(revisions), [revisions]);
  const columns = Math.max(1, ...[...layout.nodes.values()].map((node) => node.column + 1));
  const stepX = columns > 1 ? Math.min(22, 92 / (columns - 1)) : 0;
  const pos = (id: string): { x: number; y: number } => {
    const node = layout.nodes.get(id);
    return { x: 6 + (node?.column ?? 0) * stepX, y: 7 + (node?.lane ?? 0) * 12 };
  };
  const height = 14 + (layout.lanes - 1) * 12;
  return (
    <svg className="lineage-sketch" width={104} height={Math.max(14, height)} viewBox={`0 0 104 ${Math.max(14, height)}`} aria-hidden="true" focusable="false">
      {revisions.flatMap((revision) =>
        revision.parentRevisionIds.map((parentId) => {
          const a = pos(parentId);
          const b = pos(revision.id);
          return <path key={`${parentId}>${revision.id}`} d={`M${a.x} ${a.y}L${b.x} ${b.y}`} stroke="var(--ink-4)" strokeWidth={1.4} fill="none" />;
        }),
      )}
      {revisions.map((revision) => {
        const p = pos(revision.id);
        const current = revision.id === currentRevisionId;
        return <rect key={revision.id} x={p.x - 4.5} y={p.y - 4.5} width={9} height={9} rx={2.5} fill={current ? "var(--accent)" : "var(--ground)"} stroke={current ? "var(--accent)" : "var(--ink-3)"} strokeWidth={1.3} />;
      })}
    </svg>
  );
}
