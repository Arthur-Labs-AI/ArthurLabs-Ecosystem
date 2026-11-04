import React from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { RunGraphEdge, RunGraphNode } from '../lib/run-graph.js';
import { AgentCanvasNode } from './nodes/AgentCanvasNode.js';
import { PipelineNode } from './nodes/PipelineNode.js';
import { NeonEdge } from './edges/NeonEdge.js';
import { useReducedMotion } from '../lib/use-reduced-motion.js';

const nodeTypes = {
  agentNode: AgentCanvasNode,
  pipelineNode: PipelineNode,
};

const edgeTypes = {
  neon: NeonEdge,
};

function layoutKeyFor(runId: string): string {
  return 'sentry:run-layout:canvas:' + runId;
}

export interface CanonicalPosition {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Merge canonical graph positions with user-moved overrides (presentation
 * state, keyed by node id). Telemetry refreshes change the canonical list;
 * overrides always win so dragging is never snapped back. New topology
 * (unknown ids) falls back to canonical positions.
 */
export function resolveCanvasPositions(
  canonical: readonly CanonicalPosition[],
  overrides: Readonly<Record<string, { x: number; y: number }>>,
): Record<string, { x: number; y: number }> {
  const resolved: Record<string, { x: number; y: number }> = {};
  for (const node of canonical) {
    resolved[node.id] = overrides[node.id] ?? { x: node.x, y: node.y };
  }
  return resolved;
}

function loadPositions(runId: string): Record<string, { x: number; y: number }> {
  try {
    const raw = window.localStorage.getItem(layoutKeyFor(runId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, position]) =>
          typeof position === 'object' &&
          position !== null &&
          Number.isFinite(position.x) &&
          Number.isFinite(position.y),
      ),
    );
  } catch {
    return {};
  }
}

function loadViewport(runId: string): Viewport | undefined {
  try {
    const raw = window.localStorage.getItem(layoutKeyFor(runId) + ':viewport');
    if (raw === null) return undefined;
    const viewport = JSON.parse(raw) as Viewport | null;
    if (
      viewport === null ||
      !Number.isFinite(viewport.x) ||
      !Number.isFinite(viewport.y) ||
      !Number.isFinite(viewport.zoom) ||
      viewport.zoom < 0.2 ||
      viewport.zoom > 2.25
    )
      return undefined;
    return viewport;
  } catch {
    return undefined;
  }
}

interface RunCanvasProps {
  runId: string;
  nodes: readonly RunGraphNode[];
  edges: readonly RunGraphEdge[];
  selectedId?: string | undefined;
  centerRequest?: { id: string; key: number } | undefined;
  onSelect: (id: string | undefined) => void;
  onSelectEdge?: (id: string | undefined) => void;
}

function toFlowNode(
  node: RunGraphNode,
  selectedId: string | undefined,
  override?: { x: number; y: number },
): Node {
  return {
    id: node.id,
    type: node.kind === 'agent' ? 'agentNode' : 'pipelineNode',
    position: override ?? node.position,
    selected: node.id === selectedId,
    data: {
      label: node.label,
      status: node.status,
      kind: node.kind,
      payload: node.data,
      selected: node.id === selectedId,
    },
  };
}

export function RunCanvas(props: RunCanvasProps): React.JSX.Element {
  return <RunCanvasScene key={props.runId} {...props} />;
}

function RunCanvasScene({
  runId,
  nodes,
  edges,
  selectedId,
  centerRequest,
  onSelect,
  onSelectEdge,
}: RunCanvasProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const duration = (ms: number): number => (reducedMotion ? 0 : ms);
  const [savedViewport] = React.useState(() => loadViewport(runId));
  const flowRef = React.useRef<
    | {
        fitView: (options?: {
          padding?: number;
          duration?: number;
          maxZoom?: number;
          nodes?: { id: string }[];
        }) => void;
        zoomIn: (options?: { duration?: number }) => void;
        zoomOut: (options?: { duration?: number }) => void;
      }
    | undefined
  >(undefined);
  // User-moved positions are local presentation state: telemetry refreshes
  // and selection changes must never snap nodes back. Keyed by node id so
  // new topology merges without losing existing positions.
  const [overrides, setOverrides] = React.useState<Record<string, { x: number; y: number }>>(() =>
    loadPositions(runId),
  );
  const overridesRef = React.useRef(overrides);
  overridesRef.current = overrides;

  const persist = React.useCallback(
    (next: Record<string, { x: number; y: number }>) => {
      try {
        window.localStorage.setItem(layoutKeyFor(runId), JSON.stringify(next));
      } catch {
        /* presentation-only; ignore quota failures */
      }
    },
    [runId],
  );

  // Avoid synchronous storage writes on every pointer movement.
  React.useEffect(() => {
    const timer = window.setTimeout(() => persist(overrides), 180);
    return () => window.clearTimeout(timer);
  }, [overrides, persist]);

  const [flowNodes, setFlowNodes] = React.useState<Node[]>(() =>
    nodes.map((node) => toFlowNode(node, selectedId, overrides[node.id])),
  );

  React.useEffect(() => {
    setFlowNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return nodes.map((node) => ({
        // Preserve React Flow measurements and drag state across telemetry.
        // Dropping measured dimensions makes subsequent drag coordinates NaN.
        ...byId.get(node.id),
        ...toFlowNode(node, selectedId, overridesRef.current[node.id]),
      }));
    });
  }, [nodes, selectedId]);
  const flowEdges: Edge[] = React.useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'neon',
        selected: edge.id === selectedId,
        data: { state: edge.state },
      })),
    [edges, selectedId],
  );

  const onNodesChange = React.useCallback((changes: NodeChange[]) => {
    setFlowNodes((previous) => applyNodeChanges(changes, previous));
    setOverrides((prev) => {
      const merged: Record<string, { x: number; y: number }> = { ...prev };
      let changed = false;
      for (const change of changes) {
        if (change.type !== 'position' || change.position === undefined) continue;
        const prior = prev[change.id];
        if (prior === undefined || change.position.x !== prior.x || change.position.y !== prior.y) {
          merged[change.id] = { ...change.position };
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, []);

  const nodesRef = React.useRef(nodes);
  nodesRef.current = nodes;

  // Centering never moves nodes: it only pans the viewport to the node.
  React.useEffect(() => {
    if (centerRequest === undefined) return;
    const node = nodesRef.current.find((n) => n.id === centerRequest.id);
    if (node === undefined) return;
    flowRef.current?.fitView({
      nodes: [{ id: node.id }],
      maxZoom: 1,
      padding: 0.4,
      duration: reducedMotion ? 0 : 450,
    });
  }, [centerRequest, reducedMotion]);

  const resetLayout = (): void => {
    try {
      window.localStorage.removeItem(layoutKeyFor(runId));
      window.localStorage.removeItem(layoutKeyFor(runId) + ':viewport');
    } catch {
      /* ignore */
    }
    setOverrides({});
    setFlowNodes((previous) =>
      previous.map((node) => ({
        ...node,
        position: nodes.find((canonical) => canonical.id === node.id)?.position ?? node.position,
      })),
    );
    window.requestAnimationFrame(() =>
      flowRef.current?.fitView({ duration: duration(400), padding: 0.18, maxZoom: 1.15 }),
    );
  };

  return (
    <div
      className="canvas-host"
      style={{ height: '100%' }}
      role="application"
      tabIndex={0}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.toLowerCase() === 'f') {
          event.preventDefault();
          flowRef.current?.fitView({ duration: duration(400), padding: 0.18 });
        }
        if (event.key === '+' || event.key === '=')
          flowRef.current?.zoomIn({ duration: duration(200) });
        if (event.key === '-') flowRef.current?.zoomOut({ duration: duration(200) });
      }}
      aria-label="Run execution canvas. Drag nodes to rearrange; layout is saved for this run."
    >
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
        <button
          className="icon-btn ghost"
          onClick={() => flowRef.current?.zoomOut({ duration: duration(200) })}
          aria-label="Zoom out (-)"
          title="Zoom out (-)"
        >
          <ZoomOut size={15} />
        </button>
        <button
          className="icon-btn ghost"
          onClick={() => flowRef.current?.zoomIn({ duration: duration(200) })}
          aria-label="Zoom in (+)"
          title="Zoom in (+)"
        >
          <ZoomIn size={15} />
        </button>
        <button
          className="icon-btn ghost"
          onClick={() => flowRef.current?.fitView({ duration: duration(400), padding: 0.18 })}
          aria-label="Fit view (F). Keeps your node layout."
          title="Fit view (F). Keeps your node layout."
        >
          <Maximize size={15} />
        </button>
        <button
          className="icon-btn ghost"
          onClick={resetLayout}
          aria-label="Reset layout to canonical positions"
          title="Reset layout: restore canonical node positions and fit view"
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_event, node) =>
          persist({ ...overridesRef.current, [node.id]: node.position })
        }
        onMoveEnd={(_event, viewport) => {
          try {
            window.localStorage.setItem(
              layoutKeyFor(runId) + ':viewport',
              JSON.stringify(viewport),
            );
          } catch {
            /* presentation-only storage */
          }
        }}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onEdgeClick={(_event, edge) => (onSelectEdge ?? onSelect)(edge.id)}
        onPaneClick={() => {
          onSelect(undefined);
          onSelectEdge?.(undefined);
        }}
        fitView={savedViewport === undefined}
        {...(savedViewport === undefined ? {} : { defaultViewport: savedViewport })}
        fitViewOptions={{ padding: 0.18, duration: duration(450), maxZoom: 1.15 }}
        minZoom={0.2}
        maxZoom={2.25}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnDrag
        panOnScroll={false}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        elevateNodesOnSelect
        deleteKeyCode={null}
        attributionPosition="bottom-right"
        onlyRenderVisibleElements={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={26}
          size={1.4}
          color="var(--canvas-grid)"
        />
      </ReactFlow>
      <div className="canvas-hint" aria-hidden="true">
        {'Drag to arrange · Scroll to zoom · F to fit'}
      </div>
    </div>
  );
}
