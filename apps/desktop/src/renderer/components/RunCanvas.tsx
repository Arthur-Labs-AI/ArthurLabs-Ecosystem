import React from 'react';
import {
  ReactFlow,
  Background,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { RunGraphEdge, RunGraphNode } from '../lib/run-graph.js';
import { AgentCanvasNode } from './nodes/AgentCanvasNode.js';
import { PipelineNode } from './nodes/PipelineNode.js';

const nodeTypes = {
  agentNode: AgentCanvasNode,
  pipelineNode: PipelineNode,
};

function edgeStyle(state: RunGraphEdge['state']): { stroke: string; animated: boolean } {
  switch (state) {
    case 'completed':
      return { stroke: '#22c55e', animated: false };
    case 'active':
      return { stroke: '#38bdf8', animated: true };
    case 'failed':
      return { stroke: '#ef4444', animated: false };
    case 'blocked':
      return { stroke: '#6b7280', animated: false };
    default:
      return { stroke: '#39414f', animated: false };
  }
}

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
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function RunCanvas({
  runId,
  nodes,
  edges,
  selectedId,
  centerRequest,
  onSelect,
  onSelectEdge,
}: {
  runId: string;
  nodes: readonly RunGraphNode[];
  edges: readonly RunGraphEdge[];
  selectedId?: string | undefined;
  centerRequest?: { id: string; key: number } | undefined;
  onSelect: (id: string | undefined) => void;
  onSelectEdge?: (id: string | undefined) => void;
}): React.JSX.Element {
  const flowRef = React.useRef<
    | {
        fitView: () => void;
        zoomIn: () => void;
        zoomOut: () => void;
        setCenter: (x: number, y: number, options?: { zoom?: number }) => void;
      }
    | undefined
  >(undefined);
  // User-moved positions are local presentation state: telemetry refreshes
  // and selection changes must never snap nodes back. Keyed by node id so
  // new topology merges without losing existing positions.
  const [overrides, setOverrides] = React.useState<Record<string, { x: number; y: number }>>(() =>
    loadPositions(runId),
  );
  const [resetKey, setResetKey] = React.useState(0);

  // Switching runs loads that run's saved layout.
  React.useEffect(() => {
    setOverrides(loadPositions(runId));
  }, [runId]);

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

  const flowNodes: Node[] = React.useMemo(
    () =>
      nodes.map((node) => {
        const override = overrides[node.id];
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
      }),
    // resetKey restores canonical positions after a reset.
    [nodes, selectedId, overrides, resetKey],
  );
  const flowEdges: Edge[] = React.useMemo(
    () =>
      edges.map((edge) => {
        const style = edgeStyle(edge.state);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: style.animated,
          style: { stroke: style.stroke },
        };
      }),
    [edges],
  );

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      setOverrides((prev) => {
        const base: Node[] = nodes.map((node) => ({
          id: node.id,
          position: prev[node.id] ?? node.position,
          data: {},
        }));
        const next = applyNodeChanges(changes, base);
        const merged: Record<string, { x: number; y: number }> = { ...prev };
        let changed = false;
        for (const node of next) {
          const prior = prev[node.id] ?? nodes.find((n) => n.id === node.id)?.position;
          if (prior === undefined || node.position.x !== prior.x || node.position.y !== prior.y) {
            merged[node.id] = { ...node.position };
            changed = true;
          }
        }
        if (changed) persist(merged);
        return changed ? merged : prev;
      });
    },
    [nodes, persist],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === 'f') flowRef.current?.fitView();
      if (event.key === '+') flowRef.current?.zoomIn();
      if (event.key === '-') flowRef.current?.zoomOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nodesRef = React.useRef(nodes);
  nodesRef.current = nodes;
  const overridesRef = React.useRef(overrides);
  overridesRef.current = overrides;

  // Centering never moves nodes: it only pans the viewport to the node.
  React.useEffect(() => {
    if (centerRequest === undefined) return;
    const node = nodesRef.current.find((n) => n.id === centerRequest.id);
    if (node === undefined) return;
    const position = overridesRef.current[centerRequest.id] ?? node.position;
    flowRef.current?.setCenter(position.x + 110, position.y + 60, { zoom: 1 });
  }, [centerRequest]);

  const resetLayout = (): void => {
    try {
      window.localStorage.removeItem(layoutKeyFor(runId));
    } catch {
      /* ignore */
    }
    setOverrides({});
    setResetKey((k) => k + 1);
    window.setTimeout(() => flowRef.current?.fitView(), 0);
  };

  return (
    <div
      className="canvas-host"
      style={{ height: '100%' }}
      role="application"
      aria-label="Run execution canvas. Drag nodes to rearrange; layout is saved for this run."
    >
      <div className="grid-bg" />
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
        <button
          className="icon-btn ghost"
          onClick={() => flowRef.current?.zoomOut()}
          aria-label="Zoom out (-)"
          title="Zoom out (-)"
        >
          <ZoomOut size={15} />
        </button>
        <button
          className="icon-btn ghost"
          onClick={() => flowRef.current?.zoomIn()}
          aria-label="Zoom in (+)"
          title="Zoom in (+)"
        >
          <ZoomIn size={15} />
        </button>
        <button
          className="icon-btn ghost"
          onClick={() => flowRef.current?.fitView()}
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
        onNodesChange={onNodesChange}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onEdgeClick={(_event, edge) => (onSelectEdge ?? onSelect)(edge.id)}
        onPaneClick={() => {
          onSelect(undefined);
          onSelectEdge?.(undefined);
        }}
        fitView
        minZoom={0.3}
        maxZoom={1.75}
        attributionPosition="bottom-right"
        onlyRenderVisibleElements={false}
      >
        <Background gap={24} color="#1c2330" />
      </ReactFlow>
    </div>
  );
}
