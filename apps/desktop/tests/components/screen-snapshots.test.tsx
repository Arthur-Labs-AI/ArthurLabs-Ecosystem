import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { AgentCanvasNode } from '../../src/renderer/components/nodes/AgentCanvasNode.js';
import { PipelineNode } from '../../src/renderer/components/nodes/PipelineNode.js';
import { AgentInspector } from '../../src/renderer/components/AgentInspector.js';
import {
  MergerInspector,
  VerifierInspector,
  IssuesInspector,
} from '../../src/renderer/components/PipelineInspectors.js';
import { buildRetestGraph, buildRunGraph } from '../../src/renderer/lib/run-graph.js';
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
      executionKind: 'simulation',
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
  it('renders three agent branches plus pipeline nodes', () => {
    const graph = buildRunGraph(fullRunInput());
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).toContain('project');
    expect(kinds).toContain('revision');
    expect(kinds).toContain('snapshot');
    expect(kinds.filter((k) => k === 'agent')).toHaveLength(3);
    expect(kinds).toContain('merger');
    expect(kinds).toContain('verifier');
    expect(kinds).toContain('issues');
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

  it('agent inspector exposes timeline, telemetry, findings, tokens', () => {
    const view = makeAgentNodeView({ status: 'running' });
    const html = renderToStaticMarkup(
      React.createElement(AgentInspector, {
        data: {
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
        },
      }),
    );
    expect(html).toContain('Timeline');
    expect(html).toContain('Telemetry');
    expect(html).toContain('Tokens');
    expect(html).toContain('Refresh token reuse');
  });

  it('merger inspector shows usable/unavailable without confidence conflation', () => {
    const html = renderToStaticMarkup(
      React.createElement(MergerInspector, {
        payload: {
          mergeResultId: 'merge_01K7777777777777777777A8W1',
          usableAgentCount: 2,
          expectedAgentCount: 3,
          unavailableAgentStackIds: ['stack_glm_main'],
          clusters: [
            {
              id: 'cluster_01K7777777777777777777A8W1',
              agreementState: 'multi_source',
              supportingAgentCount: 2,
              usableAgentCount: 2,
              sourceAgentStackIds: ['stack_muse_main', 'stack_deepseek_main'],
            },
          ],
        },
      }),
    );
    expect(html).toContain('Merger v2');
    expect(html).toContain('2');
    expect(html).toContain('stack_glm_main');
    expect(html).toContain('Agreement is not confidence');
  });

  it('verifier inspector breaks down outcomes and stays honest on inconclusive', () => {
    const html = renderToStaticMarkup(
      React.createElement(VerifierInspector, {
        payload: {
          attempts: [
            { id: 'a1', findingClusterId: 'c1', status: 'completed', outcome: 'reproduced' },
            { id: 'a2', findingClusterId: 'c2', status: 'completed', outcome: 'inconclusive' },
          ],
        },
      }),
    );
    expect(html).toContain('Verifier v3');
    expect(html).toContain('REPRODUCED');
    expect(html).toContain('INCONCLUSIVE');
    expect(html.toLowerCase()).not.toContain('bug-free');
  });

  it('issues node never claims bug-free on zero findings', () => {
    const html = renderToStaticMarkup(
      withFlow(
        React.createElement(
          PipelineNode,
          flowNodeProps({
            label: 'Issues',
            status: 'completed',
            kind: 'issues',
            payload: { count: 0, findings: [] },
          }) as never,
        ),
      ),
    );
    expect(html).toContain('No issues ingested');
    expect(html.toLowerCase()).not.toContain('bug-free');
    const withIssues = renderToStaticMarkup(
      React.createElement(IssuesInspector, {
        payload: { count: 1 },
        occurrences: [{ id: 'occ_1', issueId: 'issue_1', findingClusterId: 'c1' }],
      }),
    );
    expect(withIssues).toContain('1 created');
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

describe('screen snapshots: RETEST workspace', () => {
  it('shows A→B lineage and assessment for every outcome', () => {
    for (const outcome of ['fixed', 'still_reproducible', 'partially_fixed', 'inconclusive']) {
      const graph = buildRetestGraph({
        ...fullRunInput(),
        sourceRevisionId: 'rev_01K7777777777777777777A8W1',
        targetRevisionId: 'rev_01K7777777777777777777A8W2',
        assessment: { outcome },
      });
      expect(graph.nodes.some((n) => n.kind === 'retest-source')).toBe(true);
      expect(graph.nodes.some((n) => n.kind === 'retest-spec')).toBe(true);
      const assessment = graph.nodes.find((n) => n.kind === 'retest-assessment');
      expect(assessment?.data['outcome']).toBe(outcome);
    }
  });
});
