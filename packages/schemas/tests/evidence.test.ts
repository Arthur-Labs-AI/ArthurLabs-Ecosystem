import { describe, expect, it } from 'vitest';
import { EvidenceSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const base = {
  schemaVersion: 1,
  id: 'ev_01K7777777777777777777A8W9',
  qaRunId: 'run_01K7777777777777777777A8W3',
  type: 'command',
  strength: 'reproduced_failure',
  environmentState: 'modified_workspace',
  command: { command: 'pnpm vitest run', exitCode: 1 },
  artifactIds: [],
  createdAt: T,
};
const { command: _baseCommand, ...baseWithoutCommand } = base;
void _baseCommand;

describe('EvidenceSchema', () => {
  it('accepts command evidence with nonzero exit', () => {
    expect(EvidenceSchema.safeParse(base).success).toBe(true);
  });
  it('accepts browser evidence', () => {
    expect(
      EvidenceSchema.safeParse({
        ...baseWithoutCommand,
        type: 'browser',
        browser: { url: 'https://example.com' },
      }).success,
    ).toBe(true);
  });
  it('accepts static-analysis evidence', () => {
    const v = {
      ...baseWithoutCommand,
      type: 'static_analysis',
      staticAnalysis: { tool: 'tsc', message: 'boom' },
    };
    expect(EvidenceSchema.safeParse(v).success).toBe(true);
  });
  it('accepts runtime and code-reference evidence', () => {
    expect(
      EvidenceSchema.safeParse({
        ...baseWithoutCommand,
        type: 'runtime',
        runtime: { summary: 'Process exited after startup' },
      }).success,
    ).toBe(true);
    expect(
      EvidenceSchema.safeParse({
        ...baseWithoutCommand,
        type: 'code_reference',
        codeReference: { relativePath: 'src/a.ts', startLine: 4, endLine: 8 },
      }).success,
    ).toBe(true);
  });
  it('requires meaningful browser, log, and manual details', () => {
    expect(
      EvidenceSchema.safeParse({ ...baseWithoutCommand, type: 'browser', browser: {} }).success,
    ).toBe(false);
    expect(
      EvidenceSchema.safeParse({ ...baseWithoutCommand, type: 'log', log: { source: 'app' } })
        .success,
    ).toBe(false);
    expect(
      EvidenceSchema.safeParse({ ...baseWithoutCommand, type: 'manual', manual: {} }).success,
    ).toBe(false);
  });
  it('rejects negative duration and bad strength', () => {
    expect(
      EvidenceSchema.safeParse({ ...base, command: { command: 'x', exitCode: 0, durationMs: -5 } })
        .success,
    ).toBe(false);
    expect(EvidenceSchema.safeParse({ ...base, strength: 'grade-a' }).success).toBe(false);
  });
  it('documents exit-code semantics: any integer survives (cross-platform)', () => {
    expect(
      EvidenceSchema.safeParse({ ...base, command: { command: 'x', exitCode: 3221225477 } })
        .success,
    ).toBe(true);
  });

  it.each([
    ['command', 'command'],
    ['runtime', 'runtime'],
    ['browser', 'browser'],
    ['static_analysis', 'staticAnalysis'],
    ['code_reference', 'codeReference'],
  ] as const)('requires the %s payload', (type, payloadKey) => {
    const value = { ...base, type } as Record<string, unknown>;
    delete value.command;
    delete value[payloadKey];
    expect(EvidenceSchema.safeParse(value).success).toBe(false);
  });

  it('rejects contradictory subtype payloads', () => {
    expect(
      EvidenceSchema.safeParse({ ...base, browser: { url: 'https://example.com' } }).success,
    ).toBe(false);
  });

  it.each([
    ['test', 'test', { framework: 'vitest', name: 'auth suite', status: 'passed' }],
    ['log', 'log', { source: 'app', summary: 'Unhandled rejection' }],
    ['manual', 'manual', { summary: 'Verified by inspection', author: 'QA reviewer' }],
  ] as const)('accepts a meaningful %s payload', (type, payloadKey, payload) => {
    const value: Record<string, unknown> = { ...base, type, [payloadKey]: payload };
    delete value.command;
    expect(EvidenceSchema.safeParse(value).success).toBe(true);
  });

  it.each([{ startLine: 0 }, { startLine: 9, endLine: 3 }, { endLine: 3 }])(
    'applies shared location rules to static analysis: %j',
    (location) => {
      const value = {
        ...baseWithoutCommand,
        type: 'static_analysis',
        staticAnalysis: {
          tool: 'eslint',
          message: 'problem',
          locations: [{ relativePath: 'src/a.ts', ...location }],
        },
      };
      expect(EvidenceSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    { relativePath: 'src/a.ts', startLine: 0 },
    { relativePath: 'src/a.ts', startLine: 9, endLine: 3 },
    { relativePath: 'src/a.ts', endLine: 3 },
    { relativePath: 'C:/src/a.ts' },
    { relativePath: '/src/a.ts' },
    { relativePath: '../src/a.ts' },
  ])('applies shared location rules to code references: %j', (codeReference) => {
    const value = { ...baseWithoutCommand, type: 'code_reference', codeReference };
    expect(EvidenceSchema.safeParse(value).success).toBe(false);
  });
});
