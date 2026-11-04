import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { AgentCanvasNode } from '../../src/renderer/components/nodes/AgentCanvasNode.js';
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
});
