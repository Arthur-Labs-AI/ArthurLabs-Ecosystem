import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { AgentCanvasNode } from '../../src/renderer/components/nodes/AgentCanvasNode.js';
import { PipelineNode } from '../../src/renderer/components/nodes/PipelineNode.js';
import { AgentInspector } from '../../src/renderer/components/AgentInspector.js';
import { buildRunGraph } from '../../src/renderer/lib/run-graph.js';
import { makeAgentNodeView, makeAgentRun, resetFixtureCounter } from '../fixtures.js';

/**
 * Structural snapshots (§177) for the key screens. These run in vitest
 * (sandbox-safe) and assert rendered structure/honesty strings. Pixel
 * snapshots via Playwright Electron remain a CI follow-up (needs display).
 */

function withFlow(element: React.ReactElement): React.ReactElement {
  return React.createElement(ReactFlowProvider, null, element);
}

function flowNodeProps(data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'node-x',
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

function fullRunInput() {
  resetFixtureCounter();
  const qaRunId = 'run_01K7777777777777777777A8W1';
  const agents = [
    makeAgentRun({
      id: 'arun_01K7777777777777777777A8W1',
      qaRunId,
      agentStackId: 'stack_muse_main',
      status: 'completed',
    }),
    makeAgentRun({
      id: 'arun_01K7777777777777777777A8W2',
      qaRunId,
      agentStackId: 'stack_deepseek_main',
      status: 'running',
    }),
    makeAgentRun({
      id: 'arun_01K7777777777777777777A8W3',
      qaRunId,
      agentStackId: 'stack_glm_main',
      status: 'failed',
    }),
  ];
  return {
    run: {
      id: qaRunId,
      projectId: 'proj_01K7777777777777777777A8W1',
      mode: 'full',
      status: 'agents_running',
      executionKind: 'production',
      snapshotId: 'snap_01K7777777777777777777A8W1',
      createdAt: '2026-09-18T22:14:08.000Z',
      startedAt: '2026-09-18T22:14:08.000Z',
      configuration: {
        agentStackIds: ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main'],
      },
    },
    agentRuns: agents,
    findings: [
      {
        id: 'find_01K7777777777777777777A8W1',
        agentRunId: agents[0]?.id ?? '',
        severity: 'high',
        title: 'Refresh token reuse',
      },
    ],
    evidence: [
      { id: 'ev_01K7777777777777777777A8W1', agentRunId: agents[0]?.id ?? '', type: 'test' },
    ],
  };
}

describe('screen snapshots: FULL run workspace', () => {
  it('renders three agent branches with no downstream pipeline nodes', () => {
    const graph = buildRunGraph(fullRunInput());
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).toContain('project');
    expect(kinds).toContain('revision');
    expect(kinds).toContain('snapshot');
    expect(kinds.filter((k) => k === 'agent')).toHaveLength(3);
    // Retired pipeline: terminal runs expose Export JSON / Export Log /
    // Open Project — never Merge / Verify / Ingest Issues nodes.
    expect(kinds).not.toContain('merger');
    expect(kinds).not.toContain('verifier');
    expect(kinds).not.toContain('issues');
    // Failed agent stays visible.
    expect(graph.nodes.find((n) => n.id === 'agent-stack_glm_main')?.status).toBe('failed');
  });

  it('agent node shows live execution without fabricated reasoning', () => {
    const view = makeAgentNodeView({ status: 'running' });
    const html = renderToStaticMarkup(
      withFlow(
        React.createElement(
          AgentCanvasNode,
          flowNodeProps({
            label: 'Muse',
            status: 'running',
            kind: 'agent',
            payload: { view, agentStackId: view.agentStackId },
          }) as never,
        ),
      ),
    );
    expect(html).toContain('Muse');
    expect(html).toContain('Runtime Validation');
    expect(html).toContain('Read src/auth/session.ts');
    expect(html.toLowerCase()).not.toContain('thinking');
    expect(html.toLowerCase()).not.toContain('chain-of-thought');
    expect(html).not.toContain('% done');
    expect(html).not.toContain('minutes remaining');
  });

  it('agent inspector exposes tabbed timeline, telemetry, findings, tokens', () => {
    const view = makeAgentNodeView({ status: 'running' });
    const data = {
      view,
      events: [
        {
          type: 'run.started',
          agentRunId: view.agentRunId,
          timestamp: '2026-09-18T22:14:08.000Z',
        },
        {
          type: 'file.read',
          agentRunId: view.agentRunId,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'src/auth/session.ts',
        },
      ],
      findings: [{ id: 'f1', title: 'Refresh token reuse', severity: 'high' }],
      evidence: [{ id: 'e1', type: 'test' }],
    };
    // Overview tab: status, model, metrics including tokens.
    const overview = renderToStaticMarkup(
      React.createElement(AgentInspector, { data, initialTab: 'overview' }),
    );
    expect(overview).toContain('Overview');
    expect(overview).toContain('Activity');
    expect(overview).toContain('Evidence');
    expect(overview).toContain('Tokens');
    // Findings tab keeps the full finding accessible.
    const findings = renderToStaticMarkup(
      React.createElement(AgentInspector, { data, initialTab: 'findings' }),
    );
    expect(findings).toContain('Refresh token reuse');
    // Activity tab keeps the interactive timeline with category filters.
    const activity = renderToStaticMarkup(
      React.createElement(AgentInspector, { data, initialTab: 'activity' }),
    );
    expect(activity).toContain('Files');
    expect(activity).toContain('Commands');
    expect(activity).toContain('src/auth/session.ts');
  });
});

describe('screen snapshots: TARGETED workspace', () => {
  it('adds the target node with scope', () => {
    const graph = buildRunGraph({
      ...fullRunInput(),
      run: { ...fullRunInput().run, mode: 'targeted' },
      targetSpec: { includePaths: ['src/auth'], userInstructions: 'Focus refresh tokens' },
    });
    const target = graph.nodes.find((n) => n.kind === 'target');
    expect(target).toBeDefined();
    const html = renderToStaticMarkup(
      withFlow(
        React.createElement(
          PipelineNode,
          flowNodeProps({
            label: 'Target',
            status: 'completed',
            kind: 'target',
            payload: { includePaths: ['src/auth'] },
          }) as never,
        ),
      ),
    );
    expect(html).toContain('src/auth');
  });
});
