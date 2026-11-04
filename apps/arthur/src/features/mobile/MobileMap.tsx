import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { CognitiveRelation } from "@arthur/contracts";
import { Icon } from "../../components/icons";
import { RelationMarkers } from "../../components/RelationArt";
import { NodeShape, wrap } from "../graph/GraphCanvas";
import { layoutGraph, type GraphNode } from "../graph/graph-layout";
import { RELATION_GEOMETRY, RELATION_LABELS } from "../graph/relation-style";

export type MapSelection = { type: "node"; id: string } | { type: "edge"; id: string } | null;

const MIN_K = 0.4;
const MAX_K = 2.8;
const MM_W = 84;
const MM_H = 66;
/** Smallest comfortable target, in screen pixels, however far the map is zoomed out. */
const HIT_PX = 24;

interface View {
  x: number;
  y: number;
  k: number;
}

const zoomBand = (k: number): "lo" | "mid" | "hi" => (k < 0.75 ? "lo" : k < 1.5 ? "mid" : "hi");

function activate(action: () => void) {
  return (event: KeyboardEvent<SVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}

/**
 * The cognitive graph as a touch canvas. The layout is the production one, computed once for every relation (so the
 * filters never move a node). The map never fits itself to the screen: it opens at 1x on one idea, and the user
 * pans, pinches or uses +/−. Gestures change a transform directly; nothing re-renders while a finger is moving.
 */
export function MobileMap({
  objects,
  externals,
  relations,
  shown,
  selection,
  onSelect,
  focusId,
  bottomInset,
}: {
  objects: readonly GraphNode[];
  /** Nodes that belong to another project, by id, with that project's name. Drawn marked; not ideas of this map. */
  externals?: ReadonlyMap<string, string>;
  relations: readonly CognitiveRelation[];
  shown: readonly CognitiveRelation[];
  selection: MapSelection;
  onSelect: (selection: MapSelection) => void;
  focusId: string | null;
  /** Height covered by a sheet, so the focused idea is centred in what is still visible. */
  bottomInset: number;
}) {
  const layout = useMemo(() => layoutGraph(objects, relations, "full"), [objects, relations]);
  const edgeLayout = useMemo(() => new Map(layout.edges.map((edge) => [edge.id, edge])), [layout]);
  const titles = useMemo(() => new Map(objects.map((object) => [object.id, object.title])), [objects]);
  const drawn = shown.filter((relation) => edgeLayout.has(relation.id));

  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ w: 360, h: 440 });
  const latest = useRef({ onSelect, layout, bottomInset });
  latest.current = { onSelect, layout, bottomInset };
  const placed = useRef(false);

  // Focus: the selected idea and its neighbourhood, or the selected connection and its two ends.
  const focus = useMemo(() => {
    if (!selection) return null;
    const nodes = new Set<string>();
    const edges = new Set<string>();
    if (selection.type === "node") {
      nodes.add(selection.id);
      for (const relation of drawn) {
        if (relation.sourceObjectId === selection.id || relation.targetObjectId === selection.id) {
          nodes.add(relation.sourceObjectId);
          nodes.add(relation.targetObjectId);
          edges.add(relation.id);
        }
      }
    } else {
      const edge = relations.find((relation) => relation.id === selection.id);
      if (edge) {
        nodes.add(edge.sourceObjectId);
        nodes.add(edge.targetObjectId);
        edges.add(edge.id);
      }
    }
    return { nodes, edges };
  }, [selection, drawn, relations]);

  const apply = useCallback(
    (animate = false) => {
      const svg = svgRef.current;
      const world = worldRef.current;
      if (!svg || !world) return;
      const { x, y, k } = viewRef.current;
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      world.style.transition = animate && !reduced ? "transform 280ms cubic-bezier(0.2, 0.7, 0.2, 1)" : "none";
      world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      svg.style.setProperty("--m-inv", (1 / k).toFixed(3));
      svg.dataset.zoom = zoomBand(k);
      for (const hit of svg.querySelectorAll<SVGCircleElement>(".m-hit")) hit.setAttribute("r", String(Math.max(Number(hit.dataset.r), HIT_PX / k)));
      for (const label of svg.querySelectorAll<SVGGElement>(".m-elabel-in")) label.setAttribute("transform", `scale(${(1 / k).toFixed(3)})`);
      const view = svg.parentElement?.querySelector<SVGRectElement>(".m-mm-view");
      if (view) {
        const { viewBox } = latest.current.layout;
        const scale = Math.min(MM_W / viewBox.width, MM_H / viewBox.height);
        const ox = (MM_W - viewBox.width * scale) / 2;
        const oy = (MM_H - viewBox.height * scale) / 2;
        view.setAttribute("x", (ox + ((-x / k - viewBox.x) * scale)).toFixed(1));
        view.setAttribute("y", (oy + ((-y / k - viewBox.y) * scale)).toFixed(1));
        view.setAttribute("width", ((sizeRef.current.w / k) * scale).toFixed(1));
        view.setAttribute("height", ((sizeRef.current.h / k) * scale).toFixed(1));
      }
    },
    [],
  );

  /** Puts a point of the world in the middle of the visible part of the canvas. */
  const centerOn = useCallback(
    (wx: number, wy: number, k: number, animate: boolean) => {
      const { w, h } = sizeRef.current;
      const visible = Math.max(120, h - latest.current.bottomInset);
      viewRef.current = { k, x: w / 2 - wx * k, y: visible / 2 - wy * k };
      apply(animate);
    },
    [apply],
  );

  // Size, first placement, and the focus effect.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      if (svg.clientWidth > 0) sizeRef.current = { w: svg.clientWidth, h: svg.clientHeight };
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => { measure(); apply(); }) : null;
    observer?.observe(svg);
    return () => observer?.disconnect();
  }, [apply]);

  const target = useMemo(() => {
    if (selection?.type === "edge") {
      const edge = edgeLayout.get(selection.id);
      return edge ? { x: edge.labelX, y: edge.labelY } : null;
    }
    const id = selection?.type === "node" ? selection.id : focusId && layout.nodes.has(focusId) ? focusId : null;
    const hub = id ?? [...layout.nodes.values()].sort((a, b) => b.degree - a.degree)[0]?.id;
    const node = hub ? layout.nodes.get(hub) : undefined;
    return node ? { x: node.x, y: node.y } : null;
  }, [selection, edgeLayout, layout, focusId]);

  useEffect(() => {
    if (!target) return;
    const first = !placed.current;
    placed.current = true;
    centerOn(target.x, target.y, first ? 1 : Math.max(viewRef.current.k, 1), !first && selection !== null);
    // Re-centre only when the selection changes, never because a filter changed what is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.type, selection && selection.id]);

  useEffect(() => apply(), [apply, drawn.length]);

  // Pointer gestures, wheel zoom and tap-to-select, all on the SVG itself.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; vx: number; vy: number } | null = null;
    let pinch: { distance: number; k: number } | null = null;
    let moved = false;

    const local = (event: { clientX: number; clientY: number }) => {
      const rect = svg.getBoundingClientRect();
      const factor = svg.clientWidth > 0 ? rect.width / svg.clientWidth : 1;
      return { x: (event.clientX - rect.left) / factor, y: (event.clientY - rect.top) / factor };
    };
    const zoomAt = (point: { x: number; y: number }, next: number) => {
      const view = viewRef.current;
      const k = Math.max(MIN_K, Math.min(MAX_K, next));
      viewRef.current = { k, x: point.x - ((point.x - view.x) * k) / view.k, y: point.y - ((point.y - view.y) * k) / view.k };
    };

    const down = (event: PointerEvent) => {
      pointers.set(event.pointerId, local(event));
      moved = false;
      if (pointers.size === 1) drag = { ...(pointers.get(event.pointerId) as { x: number; y: number }), vx: viewRef.current.x, vy: viewRef.current.y };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: viewRef.current.k };
        drag = null;
      }
    };
    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      const point = local(event);
      pointers.set(event.pointerId, point);
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, (pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance);
        moved = true;
        apply();
      } else if (pointers.size === 1 && drag) {
        const dx = point.x - drag.x;
        const dy = point.y - drag.y;
        if (!moved && Math.hypot(dx, dy) < 8) return;
        moved = true;
        viewRef.current = { ...viewRef.current, x: drag.vx + dx, y: drag.vy + dy };
        apply();
      }
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const [only] = [...pointers.values()] as [{ x: number; y: number }];
        drag = { ...only, vx: viewRef.current.x, vy: viewRef.current.y };
      } else if (pointers.size === 0) {
        drag = null;
        window.setTimeout(() => (moved = false), 0);
      }
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(local(event), viewRef.current.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
      apply();
    };
    const click = (event: MouseEvent) => {
      if (moved) return;
      const element = event.target instanceof Element ? event.target : null;
      const node = element?.closest<SVGElement>("[data-node]");
      const edge = element?.closest<SVGElement>("[data-edge]");
      if (node?.dataset.node) latest.current.onSelect({ type: "node", id: node.dataset.node });
      else if (edge?.dataset.edge) latest.current.onSelect({ type: "edge", id: edge.dataset.edge });
      else latest.current.onSelect(null);
    };

    svg.addEventListener("pointerdown", down);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
    svg.addEventListener("wheel", wheel, { passive: false });
    svg.addEventListener("click", click);
    return () => {
      svg.removeEventListener("pointerdown", down);
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      svg.removeEventListener("wheel", wheel);
      svg.removeEventListener("click", click);
    };
  }, [apply]);

  const zoomBy = (factor: number) => {
    const { w, h } = sizeRef.current;
    const view = viewRef.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, view.k * factor));
    const px = w / 2;
    const py = Math.max(120, h - latest.current.bottomInset) / 2;
    viewRef.current = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    apply(true);
  };

  const { viewBox } = layout;
  const scale = Math.min(MM_W / viewBox.width, MM_H / viewBox.height);
  const ox = (MM_W - viewBox.width * scale) / 2;
  const oy = (MM_H - viewBox.height * scale) / 2;
  const view = viewRef.current;
  const labelClass = (id: string, degree: number): string => {
    if (focus?.nodes.has(id)) return "m-label lab-0";
    return degree >= (focus ? 4 : 3) ? "m-label lab-1" : "m-label lab-2";
  };

  return (
    <div className="m-map">
      <svg
        ref={svgRef}
        className="m-mapsvg"
        role="group"
        aria-label="Connections map. Drag to pan, pinch or use the zoom buttons to zoom."
        data-zoom={zoomBand(view.k)}
        style={{ ["--m-inv" as string]: (1 / view.k).toFixed(3) }}
      >
        <RelationMarkers prefix="mob" />
        <g ref={worldRef} className="m-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {drawn.map((relation) => {
            const edge = edgeLayout.get(relation.id);
            if (!edge) return null;
            const geometry = RELATION_GEOMETRY[relation.kind];
            const selected = selection?.type === "edge" && selection.id === relation.id;
            const dim = focus !== null && !focus.edges.has(relation.id);
            const colour = `var(--rel-${relation.kind})`;
            const marker = geometry.arrow ? `url(#mob-${relation.kind})` : undefined;
            const name = `Edge: ${titles.get(relation.sourceObjectId) ?? "?"} ${RELATION_LABELS[relation.kind]} ${titles.get(relation.targetObjectId) ?? "?"}`;
            const select = () => onSelect({ type: "edge", id: relation.id });
            return (
              <g key={relation.id} className={`m-edge${dim ? " dim" : ""}${selected ? " selected" : ""}`} data-kind={relation.kind} data-edge={relation.id}>
                {selected && <path d={edge.path} fill="none" stroke={colour} strokeWidth={10} opacity={0.18} strokeLinecap="round" />}
                <path d={edge.path} fill="none" stroke={colour} strokeWidth={geometry.width * (selected ? 1.25 : 1)} strokeDasharray={geometry.dash || undefined} strokeLinecap={geometry.round ? "round" : "butt"} markerEnd={marker} markerStart={geometry.arrow === "bars" ? marker : undefined} />
                {geometry.double && <path d={edge.path} fill="none" stroke="var(--ground)" strokeWidth={1.7} />}
                <path className="m-edge-hit" d={edge.path} role="button" tabIndex={0} aria-label={name} aria-pressed={selected} onKeyDown={activate(select)} />
              </g>
            );
          })}
          {objects.map((object) => {
            const node = layout.nodes.get(object.id);
            if (!node) return null;
            const selected = selection?.type === "node" && selection.id === object.id;
            const dim = focus !== null && !focus.nodes.has(object.id);
            const select = () => onSelect({ type: "node", id: object.id });
            const lines = wrap(object.title, 18);
            const project = externals?.get(object.id);
            return (
              <g key={object.id} className={`m-node${selected ? " selected" : ""}${dim ? " dim" : ""}${project !== undefined ? " external" : ""}`} transform={`translate(${node.x},${node.y})`} data-node={object.id} role="button" tabIndex={0} aria-label={project !== undefined ? `Node: ${object.title}, in ${project}` : `Node: ${object.title}`} aria-pressed={selected} onKeyDown={activate(select)}>
                {selected && <circle r={node.r + 11} fill="var(--accent)" opacity={0.13} />}
                <g className="m-shape" data-kind={object.kind}>
                  <NodeShape kind={object.kind} r={node.r} />
                </g>
                <circle className="m-hit" data-r={node.r} r={Math.max(node.r, HIT_PX / view.k)} />
                <text className={`${labelClass(object.id, node.degree)}${selected ? " selected" : ""}`} textAnchor="middle" y={node.r + 16} aria-hidden="true">
                  {lines.map((line, i) => (
                    <tspan key={i} x={0} dy={i === 0 ? 0 : "1.2em"}>
                      {line}
                    </tspan>
                  ))}
                  {project !== undefined && (
                    <tspan className="m-node-project" x={0} dy="1.2em">
                      {project} ↗
                    </tspan>
                  )}
                </text>
              </g>
            );
          })}
          {selection?.type === "edge" &&
            drawn
              .filter((relation) => relation.id === selection.id)
              .map((relation) => {
                const edge = edgeLayout.get(relation.id);
                if (!edge) return null;
                const text = RELATION_LABELS[relation.kind];
                const width = text.length * 7 + 16;
                const colour = `var(--rel-${relation.kind})`;
                return (
                  <g key={`label-${relation.id}`} transform={`translate(${edge.labelX},${edge.labelY})`} aria-hidden="true">
                    <g className="m-elabel-in" transform={`scale(${(1 / view.k).toFixed(3)})`}>
                      <rect x={-width / 2} y={-11} width={width} height={22} rx={4} fill="var(--overlay)" stroke={colour} strokeOpacity={0.7} />
                      <text className="m-elabel-t" textAnchor="middle" y={4.5} fill={colour}>
                        {text}
                      </text>
                    </g>
                  </g>
                );
              })}
        </g>
      </svg>

      <div className="m-mapctl" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.3)}>
          <Icon name="plus" />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          <Icon name="minus" />
        </button>
      </div>
      <div
        className="m-minimap"
        aria-hidden="true"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const wx = viewBox.x + ((event.clientX - rect.left - ox) / scale);
          const wy = viewBox.y + ((event.clientY - rect.top - oy) / scale);
          centerOn(wx, wy, viewRef.current.k, true);
        }}
      >
        <svg viewBox={`0 0 ${MM_W} ${MM_H}`}>
          {objects.map((object) => {
            const node = layout.nodes.get(object.id);
            if (!node) return null;
            const on = selection?.type === "node" && selection.id === object.id;
            return <circle key={object.id} cx={ox + (node.x - viewBox.x) * scale} cy={oy + (node.y - viewBox.y) * scale} r={on ? 2.6 : 1.4} fill={on ? "var(--accent)" : "var(--ink-3)"} />;
          })}
          <rect className="m-mm-view" x={0} y={0} width={10} height={10} fill="none" stroke="var(--accent)" strokeWidth={1} />
        </svg>
      </div>
    </div>
  );
}
