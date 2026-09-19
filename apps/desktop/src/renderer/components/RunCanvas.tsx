import React from 'react';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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

export function RunCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  onSelectEdge,
}: {
  nodes: readonly RunGraphNode[];
  edges: readonly RunGraphEdge[];
  selectedId?: string | undefined;
  onSelect: (id: string | undefined) => void;
  onSelectEdge?: (id: string | undefined) => void;
}): React.JSX.Element {
  const flowRef = React.useRef<
    | {
        fitView: () => void;
        zoomIn: () => void;
        zoomOut: () => void;
        setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
      }
    | undefined
  >(undefined);
  const [layoutKey, setLayoutKey] = React.useState(0);

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
  // Canonical node positions are deterministic (built by run-graph). A true
  // layout reset restores them and refits the viewport (not just fitView).
  const flowNodes: Node[] = React.useMemo(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: node.kind === 'agent' ? 'agentNode' : 'pipelineNode',
        position: node.position,
        selected: node.id === selectedId,
        data: {
          label: node.label,
          status: node.status,
          kind: node.kind,
          payload: node.data,
          selected: node.id === selectedId,
        },
      })),
    [nodes, selectedId, layoutKey],
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
  return (
    <div
      className="canvas-host"
      style={{ height: '100%' }}
      role="application"
      aria-label="Run execution canvas"
    >
      <div className="grid-bg" />
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 5, display: 'flex', gap: 6 }}>
        <button
          onClick={() => flowRef.current?.fitView()}
          aria-label="Fit view (F)"
          title="Fit view (F)"
        >
          Fit
        </button>
        <button
          onClick={() => {
            // Deterministic reset: restore canonical positions, reset
            // viewport, then fit. Keyed remount restores node positions.
            flowRef.current?.setViewport({ x: 0, y: 0, zoom: 1 });
            setLayoutKey((k) => k + 1);
            window.setTimeout(() => flowRef.current?.fitView(), 0);
          }}
          aria-label="Reset layout"
          title="Reset layout: restore canonical node positions and fit view"
        >
          Reset layout
        </button>
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
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
      >
        <Background gap={24} color="#1c2330" />
        <Controls showFitView showZoom showInteractive={false} />
        <MiniMap pannable zoomable style={{ background: '#11151d' }} />
      </ReactFlow>
    </div>
  );
}
