import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../../src/renderer/components/AppShell.js';
import { AgentCanvasNode } from '../../src/renderer/components/nodes/AgentCanvasNode.js';
import { resolveCanvasPositions } from '../../src/renderer/components/RunCanvas.js';
import { clampPanelWidth } from '../../src/renderer/pages/RunWorkspace.js';
import { makeAgentNodeView } from '../fixtures.js';

function withFlow(element: React.ReactElement): React.ReactElement {
  return React.createElement(ReactFlowProvider, null, element);
}

function agentNodeProps(data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'agent-x',
    type: 'agentNode',
    selected: false,
    zIndex: 1,
    isConnectable: false,
    xPos: 0,
    yPos: 0,
    dragging: false,
    data,
  };
}

describe('primary navigation', () => {
  it('offers only current product destinations', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          React.createElement(AppShell, null),
        ),
      ),
    );
    expect(html).toContain('Dashboard');
    expect(html).toContain('Projects');
    expect(html).toContain('Environment');
    expect(html).toContain('Settings');
    expect(html).toContain('Checking runtime…');
    expect(html).not.toContain('Runtime offline');
    expect(html).not.toContain('Issues (Legacy)');
    expect(html).not.toContain('History');
    expect(html).not.toContain('>Runs<');
  });
});

describe('compact agent node density', () => {
  it('keeps summary data while dropping walls of text', () => {
    const view = makeAgentNodeView({ status: 'running' });
    const html = renderToStaticMarkup(
      withFlow(
        React.createElement(
          AgentCanvasNode,
          agentNodeProps({
            label: view.displayName,
            status: view.status,
            kind: 'agent',
            payload: { view, agentStackId: view.agentStackId },
          }) as never,
        ),
      ),
    );
    // Summary contract: agent, model, status, one operation line, metrics.
    expect(html).toContain('Muse');
    expect(html).toContain('muse-spark-1.3-contributor');
    expect(html).toContain('Read src/auth/session.ts');
    expect(html).toContain('stage-dots');
    expect(html).toContain('1 findings');
    expect(html).toContain('4 evidence');
    // Detail belongs in the inspector, not the node.
    expect(html).not.toContain('Tool started: shell');
    expect(html).not.toContain('class="stage"');
    expect(html).not.toContain('stage-current');
  });
});

describe('canvas position persistence contract', () => {
  it('preserves user positions across telemetry updates', () => {
    const first = resolveCanvasPositions(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      { a: { x: 55, y: 66 } },
    );
    expect(first['a']).toEqual({ x: 55, y: 66 });
    expect(first['b']).toEqual({ x: 100, y: 0 });
    // Topology shifts: canonical moves underneath, overrides still win,
    // and brand-new nodes fall back to canonical positions.
    const second = resolveCanvasPositions(
      [
        { id: 'a', x: 5, y: 5 },
        { id: 'b', x: 100, y: 0 },
        { id: 'c', x: 200, y: 0 },
      ],
      { a: { x: 55, y: 66 } },
    );
    expect(second['a']).toEqual({ x: 55, y: 66 });
    expect(second['c']).toEqual({ x: 200, y: 0 });
  });
});

describe('resizable panel constraints', () => {
  it('clamps widths so panels never crush or overlap the canvas', () => {
    expect(clampPanelWidth(100, 220, 400)).toBe(220);
    expect(clampPanelWidth(280, 220, 400)).toBe(280);
    expect(clampPanelWidth(900, 220, 400)).toBe(400);
    expect(clampPanelWidth(100, 300, 600)).toBe(300);
    expect(clampPanelWidth(900, 300, 600)).toBe(600);
  });
});
