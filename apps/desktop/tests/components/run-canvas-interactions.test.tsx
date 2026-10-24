import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeChange, ReactFlowProps } from '@xyflow/react';
import { RunCanvas } from '../../src/renderer/components/RunCanvas.js';
import type { RunGraphNode } from '../../src/renderer/lib/run-graph.js';

const flow = vi.hoisted(() => ({
  props: {} as ReactFlowProps,
  fitView: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    ReactFlow: (props: ReactFlowProps) => {
      flow.props = props;
      React.useEffect(() => {
        props.onInit?.({
          fitView: flow.fitView,
          zoomIn: flow.zoomIn,
          zoomOut: flow.zoomOut,
        } as never);
      }, []);
      return <div data-testid="flow" />;
    },
    Background: () => null,
  };
});
const canonical: RunGraphNode[] = [
  {
    id: 'a',
    kind: 'agent',
    label: 'OpenCode',
    status: 'running',
    position: { x: 10, y: 20 },
    data: {},
  },
  {
    id: 'b',
    kind: 'agent',
    label: 'DeepSeek',
    status: 'pending',
    position: { x: 260, y: 20 },
    data: {},
  },
];
const props = { runId: 'r', nodes: canonical, edges: [], onSelect: vi.fn() };
beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const change = (changes: NodeChange[]): void => act(() => flow.props.onNodesChange?.(changes));
const first = (): Node => flow.props.nodes?.[0] as Node;

describe('controlled graph lifecycle', () => {
  it('reflects inspected edges without changing their endpoints', () => {
    render(
      <RunCanvas
        {...props}
        edges={[{ id: 'a-b', source: 'a', target: 'b', state: 'active' }]}
        selectedId="a-b"
      />,
    );
    expect(flow.props.edges?.[0]).toMatchObject({
      id: 'a-b',
      source: 'a',
      target: 'b',
      selected: true,
      type: 'neon',
    });
  });
  it('preserves measurements through dragging, selection, and telemetry refresh', () => {
    const view = render(<RunCanvas {...props} />);
    change([{ id: 'a', type: 'dimensions', dimensions: { width: 220, height: 140 } }]);
    change([{ id: 'a', type: 'position', position: { x: 95, y: 85 }, dragging: true }]);
    expect(first().measured).toEqual({ width: 220, height: 140 });
    expect(first().dragging).toBe(true);
    view.rerender(
      <RunCanvas
        {...props}
        selectedId="a"
        nodes={canonical.map((node) => ({ ...node, status: 'completed' }))}
      />,
    );
    expect(first().position).toEqual({ x: 95, y: 85 });
    expect(first().measured).toEqual({ width: 220, height: 140 });
    expect(first().selected).toBe(true);
    expect(first().data['status']).toBe('completed');
    expect(flow.props.nodes?.[1]?.position).toEqual(canonical[1]?.position);
  });

  it('isolates layouts by run and ignores malformed stored coordinates', () => {
    localStorage.setItem(
      'sentry:run-layout:canvas:r',
      JSON.stringify({ a: { x: 'bad', y: null }, b: { x: 300, y: 90 } }),
    );
    const view = render(<RunCanvas {...props} />);
    expect(first().position).toEqual({ x: 10, y: 20 });
    expect(flow.props.nodes?.[1]?.position).toEqual({ x: 300, y: 90 });
    change([{ id: 'a', type: 'position', position: { x: 99, y: 55 } }]);
    view.rerender(<RunCanvas {...props} runId="another-run" />);
    expect(first().position).toEqual({ x: 10, y: 20 });
    expect(flow.props.nodes?.[1]?.position).toEqual({ x: 260, y: 20 });
  });

  it('persists a completed drag immediately and reset retains measured dimensions', () => {
    render(<RunCanvas {...props} />);
    change([{ id: 'a', type: 'dimensions', dimensions: { width: 220, height: 140 } }]);
    change([{ id: 'a', type: 'position', position: { x: 95, y: 85 } }]);
    act(() => flow.props.onNodeDragStop?.({} as never, first(), [first()]));
    expect(JSON.parse(localStorage.getItem('sentry:run-layout:canvas:r') ?? '{}')['a']).toEqual({
      x: 95,
      y: 85,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout to canonical positions' }));
    expect(first().position).toEqual({ x: 10, y: 20 });
    expect(first().measured).toEqual({ width: 220, height: 140 });
  });

  it('scopes shortcuts to the canvas and uses immediate viewport motion when reduced', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(
      <>
        <input aria-label="Outside graph" />
        <RunCanvas {...props} />
      </>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'f' });
    expect(flow.fitView).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('application'), { key: 'f' });
    expect(flow.fitView).toHaveBeenCalledWith({ duration: 0, padding: 0.18 });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in (+)', exact: true }));
    expect(flow.zoomIn).toHaveBeenCalledWith({ duration: 0 });
    expect(flow.props.fitViewOptions?.duration).toBe(0);
  });
});
