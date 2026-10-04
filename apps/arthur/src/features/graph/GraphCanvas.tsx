import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { CognitiveRelation, CognitiveRelationKind, KnowledgeObject, KnowledgeObjectKind } from "@arthur/contracts";
import { RelationMarkers } from "../../components/RelationArt";
import { layoutGraph, type GraphScale } from "./graph-layout";
import { RELATION_GEOMETRY, RELATION_LABELS } from "./relation-style";
import "./graph.css";

export type Selection = { type: "node"; id: string } | { type: "edge"; id: string } | null;

/** Space and Enter activate a focusable SVG element, like a button. */
function activate(action: () => void) {
  return (event: KeyboardEvent<SVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}

function wrap(title: string, width: number): string[] {
  const lines: string[] = [""];
  for (const word of title.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1] as string;
    if (last && `${last} ${word}`.length > width) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  const shown = lines.slice(0, 3);
  if (lines.length > 3) shown[2] = `${(shown[2] as string).slice(0, Math.max(1, width - 1))}…`;
  return shown;
}

/** Shape says what an idea is; colour never does. Radius `r` is the visual size. */
function NodeShape({ kind, r }: { kind: KnowledgeObjectKind; r: number }) {
  const s = r * 1.02;
  switch (kind) {
    case "task":
      return <rect x={-s} y={-s} width={2 * s} height={2 * s} rx={s * 0.34} />;
    case "decision": {
      const d = s * 1.3;
      return <path d={`M0 ${-d} ${d} 0 0 ${d} ${-d} 0z`} strokeLinejoin="round" />;
    }
    case "question": {
      const h = s * 1.12;
      const points = [0, 1, 2, 3, 4, 5].map((i) => {
        const angle = Math.PI / 6 + (i * Math.PI) / 3 - Math.PI / 2;
        return `${(Math.cos(angle) * h).toFixed(1)} ${(Math.sin(angle) * h).toFixed(1)}`;
      });
      return <path d={`M${points.join("L")}z`} strokeLinejoin="round" />;
    }
    case "note":
      return (
        <>
          <rect x={-s * 0.86} y={-s} width={s * 1.72} height={2 * s} rx={s * 0.22} />
          <path d={`M${-s * 0.45} ${-s * 0.2}H${s * 0.45}M${-s * 0.45} ${s * 0.32}H${s * 0.1}`} fill="none" />
        </>
      );
    default:
      return <circle r={s * 1.05} />;
  }
}

/**
 * The cognitive graph as an SVG. Objects are nodes (shape = kind, size = number of connections); relations are edges
 * whose LINE GEOMETRY says the kind. Edge labels appear only for the current focus, so an unselected map has none.
 * Everything outside the focus dims. Every node and edge is a keyboard-operable button with a text name.
 */
export function GraphCanvas({
  objects,
  relations,
  selection = null,
  onSelect,
  enabledKinds,
  isShown,
  scale = "full",
  label = "Knowledge map",
}: {
  objects: readonly KnowledgeObject[];
  relations: readonly CognitiveRelation[];
  selection?: Selection;
  /** Omit for a non-interactive preview. */
  onSelect?: (selection: Selection) => void;
  /** Hidden kinds are not drawn but never move the nodes. Omit to draw all. */
  enabledKinds?: ReadonlySet<CognitiveRelationKind>;
  /** Further hides edges (e.g. by origin). Like `enabledKinds`, it never moves a node: the layout always sees every relation. */
  isShown?: (relation: CognitiveRelation) => boolean;
  scale?: GraphScale;
  label?: string;
}) {
  const mini = scale === "mini";
  const layout = useMemo(() => layoutGraph(objects, relations, scale), [objects, relations, scale]);
  const titles = useMemo(() => new Map(objects.map((object) => [object.id, object.title])), [objects]);
  const edgeLayout = useMemo(() => new Map(layout.edges.map((edge) => [edge.id, edge])), [layout]);
  const drawn = relations.filter((relation) => edgeLayout.has(relation.id) && (!enabledKinds || enabledKinds.has(relation.kind)) && (!isShown || isShown(relation)));

  // What is "in focus": the selected node and its neighbourhood, or the selected edge and its two ends.
  let focusNodes: Set<string> | null = null;
  let focusEdges: Set<string> | null = null;
  if (selection) {
    focusNodes = new Set();
    focusEdges = new Set();
    if (selection.type === "node") {
      focusNodes.add(selection.id);
      for (const relation of drawn) {
        if (relation.sourceObjectId === selection.id || relation.targetObjectId === selection.id) {
          focusNodes.add(relation.sourceObjectId);
          focusNodes.add(relation.targetObjectId);
          focusEdges.add(relation.id);
        }
      }
    } else {
      const edge = relations.find((relation) => relation.id === selection.id);
      if (edge) {
        focusNodes.add(edge.sourceObjectId);
        focusNodes.add(edge.targetObjectId);
        focusEdges.add(edge.id);
      }
    }
  }

  const { viewBox } = layout;
  return (
    <svg
      className={mini ? "graph mini" : "graph"}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      role={mini ? "img" : "group"}
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
      // A preview is never blown up past its natural size: that would balloon its labels instead of showing more.
      {...(mini ? { style: { maxWidth: viewBox.width * 1.1, maxHeight: viewBox.height * 1.1, margin: "0 auto" } } : {})}
    >
      <RelationMarkers prefix={mini ? "mm" : "m"} />

      {drawn.map((relation) => {
        const edge = edgeLayout.get(relation.id);
        if (!edge) return null;
        const geometry = RELATION_GEOMETRY[relation.kind];
        const selected = selection?.type === "edge" && selection.id === relation.id;
        const dim = focusEdges !== null && !focusEdges.has(relation.id);
        const colour = `var(--rel-${relation.kind})`;
        const prefix = mini ? "mm" : "m";
        const marker = geometry.arrow ? `url(#${prefix}-${relation.kind})` : undefined;
        const name = `Edge: ${titles.get(relation.sourceObjectId) ?? "?"} ${RELATION_LABELS[relation.kind]} ${titles.get(relation.targetObjectId) ?? "?"}`;
        const select = () => onSelect?.({ type: "edge", id: relation.id });
        return (
          <g key={relation.id} className={`edge${dim ? " dim" : ""}${selected ? " selected" : ""}`} data-kind={relation.kind}>
            {selected && <path d={edge.path} fill="none" stroke={colour} strokeWidth={10} opacity={0.18} strokeLinecap="round" />}
            <path
              d={edge.path}
              fill="none"
              stroke={colour}
              strokeWidth={geometry.width * (selected ? 1.25 : 1)}
              strokeDasharray={geometry.dash || undefined}
              strokeLinecap={geometry.round ? "round" : "butt"}
              markerEnd={marker}
              markerStart={geometry.arrow === "bars" ? marker : undefined}
            />
            {geometry.double && <path d={edge.path} fill="none" stroke="var(--ground)" strokeWidth={1.7} />}
            {!mini && onSelect && <path className="edge-hit" d={edge.path} role="button" tabIndex={0} aria-label={name} aria-pressed={selected} onClick={(event) => { event.stopPropagation(); select(); }} onKeyDown={activate(select)} />}
          </g>
        );
      })}

      {objects.map((object) => {
        const node = layout.nodes.get(object.id);
        if (!node) return null;
        const selected = selection?.type === "node" && selection.id === object.id;
        const dim = focusNodes !== null && !focusNodes.has(object.id);
        const select = () => onSelect?.({ type: "node", id: object.id });
        const interactive = !mini && onSelect;
        const lines = mini ? [object.title.length > 17 ? `${object.title.slice(0, 16)}…` : object.title] : wrap(object.title, 20);
        return (
          <g
            key={object.id}
            className={`node${selected ? " selected" : ""}${dim ? " dim" : ""}`}
            transform={`translate(${node.x},${node.y})`}
            {...(interactive ? { role: "button", tabIndex: 0, "aria-label": `Node: ${object.title}`, "aria-pressed": selected, onClick: (event: MouseEvent) => { event.stopPropagation(); select(); }, onKeyDown: activate(select) } : {})}
          >
            {selected && <circle r={node.r + 11} fill="var(--accent)" opacity={0.13} />}
            <g className="shape" data-kind={object.kind}>
              <NodeShape kind={object.kind} r={node.r} />
            </g>
            <text className={selected ? "node-label selected" : "node-label"} textAnchor="middle" y={node.r + (mini ? 14 : 21)} aria-hidden="true">
              {lines.map((line, i) => (
                <tspan key={i} x={0} dy={i === 0 ? 0 : 17}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}

      {!mini &&
        focusEdges &&
        drawn
          .filter((relation) => focusEdges.has(relation.id))
          .map((relation) => {
            const edge = edgeLayout.get(relation.id);
            if (!edge) return null;
            const text = RELATION_LABELS[relation.kind];
            const width = text.length * 7 + 16;
            const colour = `var(--rel-${relation.kind})`;
            return (
              <g key={`label-${relation.id}`} className="edge-label" transform={`translate(${edge.labelX},${edge.labelY})`} aria-hidden="true">
                <rect x={-width / 2} y={-10} width={width} height={20} rx={4} fill="var(--overlay)" stroke={colour} strokeOpacity={0.6} />
                <text textAnchor="middle" y={4.5} fill={colour}>
                  {text}
                </text>
              </g>
            );
          })}
    </svg>
  );
}
