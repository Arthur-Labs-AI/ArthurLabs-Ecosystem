import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { AgentCanvasNode } from '../../src/renderer/components/nodes/AgentCanvasNode.js';
import { PipelineNode } from '../../src/renderer/components/nodes/PipelineNode.js';
import { makeAgentNodeView } from '../fixtures.js';

function withFlow(element: React.ReactElement): React.ReactElement {
  return React.createElement(ReactFlowProvider, null, element);
}

describe('canvas node components', () => {
  it('renders the agent signature: name, model, stage, operation, counts', () => {
    const view = makeAgentNodeView();
    const html = renderToStaticMarkup(
      withFlow(
        React.createElement(AgentCanvasNode, {
          id: 'agent-x',
          type: 'agentNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: {
            label: view.displayName,
            status: view.status,
            kind: 'agent',
            payload: { view, agentStackId: view.agentStackId },
          },
        } as never),
      ),
    );
    expect(html).toContain('Muse');
    expect(html).toContain('muse-spark-1.3-contributor');
    expect(html).toContain('Read src/auth/session.ts');
    expect(html).toContain('1 finding');
    expect(html).toContain('4 evidence');
    expect(html).not.toContain('Thinking');
    expect(html).not.toContain('%');
  });

  it('renders waiting placeholders for unstarted agents', () => {
    const html = renderToStaticMarkup(
      withFlow(
        React.createElement(AgentCanvasNode, {
          id: 'agent-x',
          type: 'agentNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: {
            label: 'GLM',
            status: 'waiting',
            kind: 'agent',
            payload: { agentStackId: 'stack_glm_main' },
          },
        } as never),
      ),
    );
    expect(html).toContain('Waiting');
  });

  it('renders verifier outcome breakdown without implying fixed', () => {
    const verifier = renderToStaticMarkup(
      withFlow(
        React.createElement(PipelineNode, {
          id: 'verifier',
          type: 'pipelineNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: {
            label: 'Verifier v3',
            status: 'completed',
            kind: 'verifier',
            payload: {
              attempts: [
                { outcome: 'reproduced' },
                { outcome: 'partially_verified' },
                { outcome: 'not_reproducible' },
                { outcome: 'inconclusive' },
              ],
            },
          },
        } as never),
      ),
    );
    expect(verifier).toContain('Reproduced 1');
    expect(verifier).toContain('Partial 1');
    expect(verifier).toContain('Not repro 1');
    expect(verifier).toContain('Inconclusive 1');
    expect(verifier).not.toContain('fixed');
  });

  it('renders issue severity breakdown and merger usability', () => {
    const issues = renderToStaticMarkup(
      withFlow(
        React.createElement(PipelineNode, {
          id: 'issues',
          type: 'pipelineNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: {
            label: 'Issues',
            status: 'completed',
            kind: 'issues',
            payload: {
              count: 3,
              findings: [{ severity: 'critical' }, { severity: 'high' }, { severity: 'high' }],
            },
          },
        } as never),
      ),
    );
    expect(issues).toContain('3 created');
    expect(issues).toContain('1 Critical');
    expect(issues).toContain('2 High');
    const merger = renderToStaticMarkup(
      withFlow(
        React.createElement(PipelineNode, {
          id: 'merger',
          type: 'pipelineNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: {
            label: 'Merger v2',
            status: 'completed',
            kind: 'merger',
            payload: {
              clusters: [{ id: 'c1' }],
              usableAgentCount: 2,
              expectedAgentCount: 3,
              unavailableAgentStackIds: ['stack_glm_main'],
            },
          },
        } as never),
      ),
    );
    expect(merger).toContain('Agents usable 2/3');
    expect(merger).toContain('stack_glm_main');
    expect(merger).not.toContain('confidence');
  });

  it('renders merger, verifier, and issue summaries honestly', () => {
    const merger = renderToStaticMarkup(
      withFlow(
        React.createElement(PipelineNode, {
          id: 'merger',
          type: 'pipelineNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: {
            label: 'Merger v2',
            status: 'completed',
            kind: 'merger',
            payload: { clusters: [{ id: 'c1' }, { id: 'c2' }] },
          },
        } as never),
      ),
    );
    expect(merger).toContain('Merger v2');
    expect(merger).toContain('2 clusters');
    const issues = renderToStaticMarkup(
      withFlow(
        React.createElement(PipelineNode, {
          id: 'issues',
          type: 'pipelineNode',
          selected: false,
          zIndex: 1,
          isConnectable: false,
          xPos: 0,
          yPos: 0,
          dragging: false,
          data: { label: 'Issues', status: 'completed', kind: 'issues', payload: { count: 0 } },
        } as never),
      ),
    );
    expect(issues).toContain('No issues ingested');
    expect(issues).not.toContain('bug-free');
  });
});
