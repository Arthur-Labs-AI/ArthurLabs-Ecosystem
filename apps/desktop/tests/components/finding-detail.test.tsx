import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { FindingCard, FindingDetail } from '../../src/renderer/components/AgentInspector.js';

// Guard against reintroducing the old 240-char description truncation:
// the body below is 600 chars and every section must survive rendering.
const LONG_DESCRIPTION = 'D'.repeat(600);

const RICH_FINDING = {
  id: 'finding_01K7777777777777777777A8W1',
  agentRunId: 'arun_01K7777777777777777777A8W1',
  sourceAgentStackId: 'stack_opencode_main',
  title: 'Expired refresh token can still mint access tokens',
  severity: 'high',
  confidence: 'strong',
  category: 'authentication',
  description: LONG_DESCRIPTION,
  expectedBehavior: 'Expired refresh tokens must be rejected.',
  actualBehavior: 'The mint endpoint accepts them for 60 more seconds.',
  rootCause: 'Clock-skew tolerance applied to the wrong comparison.',
  recommendedFix: 'Compare expiry against issued-at instead of now.',
  reproductionSteps: ['Log in.', 'Wait for refresh expiry.', 'Call mint with the old token.'],
  locations: [
    { relativePath: 'src/auth/refresh.ts', startLine: 81, endLine: 103 },
    { relativePath: 'src/api/token.ts', startLine: 40, endLine: 66 },
  ],
  evidenceIds: ['ev_01K7777777777777777777A8W1', 'ev_01K7777777777777777777A8W2'],
};

const EVIDENCE = [
  { id: 'ev_01K7777777777777777777A8W1', type: 'test_output', strength: 'supporting' },
  { id: 'ev_01K7777777777777777777A8W2', type: 'file_excerpt' },
];

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('finding detail presentation', () => {
  it('exposes the FULL description: characters past 240 are visible', () => {
    const html = render(
      React.createElement(FindingDetail, { finding: RICH_FINDING, evidence: EVIDENCE }),
    );
    expect(html).toContain(LONG_DESCRIPTION);
    expect(html).toContain(LONG_DESCRIPTION.slice(241, 260));
    expect(html).not.toContain('\u2026');
  });

  it('renders every persisted structured section with evidence links', () => {
    const html = render(
      React.createElement(FindingDetail, { finding: RICH_FINDING, evidence: EVIDENCE }),
    );
    for (const section of [
      'Severity',
      'Confidence',
      'Category',
      'Description',
      'Expected behavior',
      'Actual behavior',
      'Root cause',
      'Reproduction steps',
      'Recommended fix',
      'Locations',
      'Evidence',
    ]) {
      expect(html).toContain(section);
    }
    expect(html).toContain('Expired refresh tokens must be rejected.');
    expect(html).toContain('Clock-skew tolerance');
    expect(html).toContain('Call mint with the old token.');
    expect(html).toContain('src/auth/refresh.ts:81\u2013103');
    expect(html).toContain('src/api/token.ts:40\u201366');
    expect(html).toContain('test_output');
    expect(html).toContain('supporting');
  });

  it('never fabricates content for absent optional fields', () => {
    const html = render(
      React.createElement(FindingDetail, {
        finding: { id: 'f1', title: 'Sparse', severity: 'low' },
        evidence: [],
      }),
    );
    expect(html).toContain('Not provided by this agent.');
    expect(html).not.toContain('undefined');
  });

  it('collapsed card previews without hiding the detail behind truncation', () => {
    const html = render(
      React.createElement(FindingCard, { finding: RICH_FINDING, evidence: EVIDENCE }),
    );
    expect(html).toContain('HIGH \u00B7 AUTHENTICATION');
    expect(html).toContain('Expired refresh token can still mint access tokens');
    expect(html).toContain('View details');
    expect(html).toContain('src/auth/refresh.ts:81\u2013103');
    // Collapsed preview only; the full body lives in the detail view.
    expect(html).not.toContain(LONG_DESCRIPTION);
  });
});
