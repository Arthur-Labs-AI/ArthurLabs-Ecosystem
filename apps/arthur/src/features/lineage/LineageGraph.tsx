import type { KeyboardEvent } from "react";
import type { ThoughtRevision } from "@arthur/contracts";
import { REVISION_RADIUS, layoutLineage } from "./lineage-layout";

function activate(action: () => void) {
  return (event: KeyboardEvent<SVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}

/**
 * The revision DAG of one object. Each arrow runs from a parent to the revision that continues it, so two arrows into
 * one revision is a merge and two arrows out of one is a branch. The current revision has a heavy ring and says so.
 */
export function LineageGraph({
  revisions,
  currentRevisionId,
  selectedRevisionId,
  onSelect,
}: {
  revisions: readonly ThoughtRevision[];
  currentRevisionId: string;
  selectedRevisionId: string;
  onSelect: (revisionId: string) => void;
}) {
  const layout = layoutLineage(revisions);
  return (
    <svg className="lineage-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Revision history" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="lineage-arrow" className="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {layout.edges.map((edge) => (
        <path key={edge.id} className="lineage-edge" d={edge.path} markerEnd="url(#lineage-arrow)" />
      ))}
      {revisions.map((revision) => {
        const node = layout.nodes.get(revision.id);
        if (!node) return null;
        const current = revision.id === currentRevisionId;
        const selected = revision.id === selectedRevisionId;
        const select = () => onSelect(revision.id);
        return (
          <g
            key={revision.id}
            className={`lineage-node origin-${revision.origin}${current ? " current" : ""}${selected ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`Revision ${node.label}${current ? " (current)" : ""}`}
            aria-pressed={selected}
            onClick={select}
            onKeyDown={activate(select)}
          >
            <circle cx={node.x} cy={node.y} r={REVISION_RADIUS} />
            <text className="lineage-node-label" x={node.x} y={node.y + 4} textAnchor="middle">
              {node.label}
            </text>
            {current && (
              <text className="lineage-current-label" x={node.x} y={node.y - REVISION_RADIUS - 6} textAnchor="middle">
                current
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
