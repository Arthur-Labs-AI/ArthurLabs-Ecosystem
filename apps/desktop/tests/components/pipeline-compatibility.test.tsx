import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EdgeInspector,
  MergerInspector,
  VerifierInspector,
} from '../../src/renderer/components/PipelineInspectors.js';

describe('retained pipeline inspectors', () => {
  it('labels saved merger data while preserving source attribution', () => {
    const html = renderToStaticMarkup(
      <MergerInspector
        payload={{
          mergerVersion: 2,
          clusters: [{ id: 'cluster-history', sourceAgentStackIds: ['stack_muse_main'] }],
        }}
      />,
    );
    expect(html).toContain('Historical');
    expect(html).toContain('Merger v2');
    expect(html).toContain('stack_muse_main');
    expect(html).toContain('Agreement is not confidence');
  });

  it('shows saved verification outcomes without offering a retired command', () => {
    const saved = renderToStaticMarkup(
      <VerifierInspector
        payload={{ attempts: [{ id: 'attempt-history', outcome: 'reproduced' }] }}
      />,
    );
    expect(saved).toContain('Historical');
    expect(saved).toContain('REPRODUCED');
    const empty = renderToStaticMarkup(<VerifierInspector payload={{}} />);
    expect(empty).toContain('No saved verification attempts');
    expect(empty).not.toContain('Run Verify');
  });

  it.each([
    { source: 'agent-stack_opencode_main', target: 'merger' },
    { source: 'merger', target: 'verifier' },
  ])('does not promise active orchestration for retained edges: %j', (edge) => {
    const html = renderToStaticMarkup(<EdgeInspector edge={edge} />);
    expect(html).not.toContain('flows into');
    expect(html).not.toContain('flow into');
  });

  it.each(['snapshot', 'target'])('describes independent execution from %s', (source) => {
    const html = renderToStaticMarkup(
      <EdgeInspector edge={{ source, target: 'agent-stack_opencode_main' }} />,
    );
    expect(html).toContain('independently');
  });
});
