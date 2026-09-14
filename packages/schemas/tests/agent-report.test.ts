import { describe, expect, it } from 'vitest';
import {
  describeSentryAgentReportContract,
  SENTRY_AGENT_REPORT_V2_VARIANT_FIELDS,
  SentryAgentReportV2Schema,
  sentryAgentReportJsonSchema,
} from '../src/index.js';

function validReport() {
  return {
    schemaVersion: 2,
    summary: 'Ledger-grounded report.',
    checks: [],
    hypotheses: [],
    evidence: [
      {
        key: 'cmd',
        type: 'command',
        strength: 'tool_diagnostic',
        description: 'Probe ran.',
        operationKey: 'op_1',
      },
      {
        key: 'ref',
        type: 'code_reference',
        strength: 'strong_code_evidence',
        description: 'Relevant line.',
        relativePath: 'src/a.ts',
        lineStart: 1,
        lineEnd: 2,
      },
    ],
    findings: [
      {
        title: 'Probe issue',
        category: 'testing',
        severity: 'info',
        confidence: 'strong',
        description: 'Observed probe.',
        locations: [{ relativePath: 'src/a.ts' }],
        evidenceKeys: ['cmd'],
        reproductionSteps: [],
      },
    ],
    limitations: [],
  };
}

describe('SentryAgentReportV2', () => {
  it('accepts the minimal valid report', () => {
    expect(SentryAgentReportV2Schema.safeParse(validReport()).success).toBe(true);
  });

  it('rejects cross-type field bleed by variant', () => {
    const cases: Array<[string, unknown]> = [
      [
        'runtime + relativePath',
        {
          key: 'e',
          type: 'runtime',
          strength: 'tool_diagnostic',
          description: 'd',
          relativePath: 'x.ts',
        },
      ],
      [
        'manual + operationKey',
        {
          key: 'e',
          type: 'manual',
          strength: 'agent_reasoning',
          description: 'd',
          operationKey: 'op_1',
        },
      ],
      [
        'code_reference without relativePath',
        { key: 'e', type: 'code_reference', strength: 'strong_code_evidence', description: 'd' },
      ],
      [
        'command without operationKey',
        { key: 'e', type: 'command', strength: 'tool_diagnostic', description: 'd' },
      ],
      [
        'command + symbol',
        {
          key: 'e',
          type: 'command',
          strength: 'tool_diagnostic',
          description: 'd',
          operationKey: 'op_1',
          symbol: 'f',
        },
      ],
      [
        'code_reference + exitCode',
        {
          key: 'e',
          type: 'code_reference',
          strength: 'strong_code_evidence',
          description: 'd',
          relativePath: 'x.ts',
          exitCode: 0,
        },
      ],
    ];
    for (const [name, evidence] of cases) {
      const parsed = SentryAgentReportV2Schema.safeParse({
        ...validReport(),
        evidence: [evidence],
      });
      expect(parsed.success, name).toBe(false);
    }
  });

  it('accepts all six valid variants', () => {
    const evidence = [
      {
        key: 'a',
        type: 'code_reference',
        strength: 'strong_code_evidence',
        description: 'd',
        relativePath: 'x.ts',
      },
      {
        key: 'b',
        type: 'command',
        strength: 'tool_diagnostic',
        description: 'd',
        operationKey: 'op_1',
      },
      {
        key: 'c',
        type: 'test',
        strength: 'tool_diagnostic',
        description: 'd',
        operationKey: 'op_2',
        framework: 'vitest',
        name: 'suite',
      },
      {
        key: 'd',
        type: 'runtime',
        strength: 'tool_diagnostic',
        description: 'd',
        operationKey: 'op_3',
      },
      { key: 'e', type: 'log', strength: 'tool_diagnostic', description: 'd', source: 'stderr' },
      { key: 'f', type: 'manual', strength: 'agent_reasoning', description: 'd' },
    ];
    const report = { ...validReport(), evidence };
    report.findings = [{ ...report.findings[0], evidenceKeys: ['a', 'b', 'c', 'd', 'e', 'f'] }];
    expect(SentryAgentReportV2Schema.safeParse(report).success).toBe(true);
  });

  it('requires reproductionSteps field presence (empty allowed)', () => {
    const report = validReport();
    const { reproductionSteps: _omitted, ...finding } = report.findings[0] as Record<
      string,
      unknown
    >;
    void _omitted;
    expect(SentryAgentReportV2Schema.safeParse({ ...report, findings: [finding] }).success).toBe(
      false,
    );
    expect(SentryAgentReportV2Schema.safeParse(report).success).toBe(true);
  });

  it('keeps the report contract consistent with the parser schema', () => {
    const description = describeSentryAgentReportContract();
    for (const kind of Object.keys(SENTRY_AGENT_REPORT_V2_VARIANT_FIELDS)) {
      expect(description).toContain(kind);
    }
    expect(description).toContain('reproductionSteps');
    expect(description).toContain('operationKey');
  });

  it('derives a JSON Schema object from the same source', () => {
    const schema = sentryAgentReportJsonSchema();
    expect(typeof schema).toBe('object');
    expect(JSON.stringify(schema)).toContain('code_reference');
  });
});
