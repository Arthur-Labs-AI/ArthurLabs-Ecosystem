import type { KeyboardEvent } from "react";
import { RELATION_KINDS, isSymmetricRelationKind, type CognitiveRelation, type KnowledgeObject } from "@arthur/contracts";
import { NODE_RADIUS, layoutGraph } from "./graph-layout";
import { RELATION_LABELS } from "./relation-style";

export type Selection = { type: "node"; id: string } | { type: "edge"; id: string } | null;

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Space and Enter activate a focusable SVG element, like a button. */
function activate(action: () => void) {
  return (event: KeyboardEvent<SVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}

/**
 * The graph as an SVG: objects are nodes, relations are edges. A directional relation has an
 * arrowhead at its target; a symmetric one has none. Every kind has its own colour AND line style,
 * and each edge carries its kind as text, so nothing depends on colour alone.
 */
export function GraphView({
  objects,
  relations,
  selection,
  onSelect,
}: {
  objects: readonly KnowledgeObject[];
  relations: readonly CognitiveRelation[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const layout = layoutGraph(objects, relations);
  const titles = new Map(objects.map((object) => [object.id, object.title]));
  const edgePaths = new Map(layout.edges.map((edge) => [edge.id, edge]));

  return (
    <svg className="graph-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Cognitive graph" preserveAspectRatio="xMidYMid meet">
      <defs>
        {RELATION_KINDS.map((kind) => (
          <marker key={kind} id={`arrow-${kind}`} className={`graph-arrow edge-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        ))}
      </defs>

      {relations.map((relation) => {
        const edge = edgePaths.get(relation.id);
        if (!edge) return null;
        const selected = selection?.type === "edge" && selection.id === relation.id;
        const label = `Edge: ${titles.get(relation.sourceObjectId) ?? "?"} ${RELATION_LABELS[relation.kind]} ${titles.get(relation.targetObjectId) ?? "?"}`;
        const select = () => onSelect({ type: "edge", id: relation.id });
        return (
          <g key={relation.id} className={`graph-edge edge-${relation.kind}${selected ? " selected" : ""}`}>
            <path className="graph-edge-line" d={edge.path} markerEnd={isSymmetricRelationKind(relation.kind) ? undefined : `url(#arrow-${relation.kind})`} />
            {/* A wide invisible stroke makes thin edges easy to tap. */}
            <path className="graph-edge-hit" d={edge.path} role="button" tabIndex={0} aria-label={label} aria-pressed={selected} onClick={select} onKeyDown={activate(select)} />
            <text className="graph-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">
              {RELATION_LABELS[relation.kind]}
            </text>
          </g>
        );
      })}

      {objects.map((object) => {
        const node = layout.nodes.get(object.id);
        if (!node) return null;
        const selected = selection?.type === "node" && selection.id === object.id;
        const select = () => onSelect({ type: "node", id: object.id });
        return (
          <g
            key={object.id}
            className={`graph-node kind-node-${object.kind}${selected ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`Node: ${object.title}`}
            aria-pressed={selected}
            onClick={select}
            onKeyDown={activate(select)}
          >
            <circle cx={node.x} cy={node.y} r={NODE_RADIUS} />
            <text className="graph-node-label" x={node.labelX} y={node.labelY} textAnchor={node.anchor}>
              {truncate(object.title, 26)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
