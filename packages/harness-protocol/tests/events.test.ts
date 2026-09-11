import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceSchema, FindingSchema, HarnessEventSchema } from '@qa/schemas';
import {
  decodeEventsNdjson,
  eventTypes,
  HarnessProtocolError,
  IncrementalHarnessEventValidator,
  validateHarnessEventSequence,
} from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const base = {
  schemaVersion: 1,
  eventId: 'evt_01K7777777777777777777A8WX',
  agentRunId: 'arun_01K7777777777777777777A8W4',
  timestamp: T,
};
const operationId = 'op_01K7777777777777777777A8WY';
const plan = {
  schemaVersion: 1,
  id: 'plan_01K7777777777777777777A8WB',
  qaRunId: 'run_01K7777777777777777777A8W3',
  agentRunId: base.agentRunId,
  agentStackId: 'stack_muse_main',
  projectSnapshotId: 'snap_01K7777777777777777777A8W2',
  projectContextSnapshotId: 'ctx_01K7777777777777777777A8WA',
  projectUnderstanding: 'A test service.',
  criticalFlows: [],
  weakPoints: [],
  plannedChecks: ['Run tests'],
  createdAt: T,
};
const hypothesis = {
  schemaVersion: 1,
  id: 'hyp_01K7777777777777777777A8WC',
  qaRunId: plan.qaRunId,
  agentRunId: base.agentRunId,
  title: 'Possible boundary defect',
  rationale: 'Observed an unexpected boundary condition.',
  relatedPaths: ['src/a.ts'],
  plannedChecks: ['Exercise the boundary'],
  discoveredAt: T,
};
const finding = FindingSchema.parse(
  JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', 'domain', 'tests', 'fixtures', 'finding.json'),
      'utf8',
    ),
  ),
);
const evidence = EvidenceSchema.parse(
  JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', 'domain', 'tests', 'fixtures', 'evidence.json'),
      'utf8',
    ),
  ),
);

describe('HarnessEvent protocol', () => {
  it('accepts every event variant', () => {
    const variants = [
      { ...base, type: 'run.started' },
      { ...base, type: 'agent.status', status: 'working' },
      { ...base, type: 'agent.message', message: 'hi' },
      { ...base, type: 'tool.started', operationId, tool: { name: 'shell' } },
      { ...base, type: 'tool.completed', operationId, tool: { name: 'shell', exitCode: 0 } },
      { ...base, type: 'command.executed', command: 'npm test', exitCode: 0 },
      { ...base, type: 'file.read', relativePath: 'src/a.ts' },
      {
        ...base,
        type: 'file.changed',
        relativePath: 'src/a.ts',
        operation: 'modify',
        purpose: 'instrumentation',
        artifactId: 'artifact_01K7777777777777777777A8WF',
      },
      { ...base, type: 'test.result', passed: 3, failed: 0 },
      { ...base, type: 'investigation.plan.created', plan },
      { ...base, type: 'investigation.hypothesis.discovered', hypothesis },
      { ...base, type: 'finding.submitted', finding },
      { ...base, type: 'evidence.submitted', evidence },
      { ...base, type: 'usage.updated', usage: { inputTokens: 1 } },
      { ...base, type: 'warning', message: 'slow' },
      { ...base, type: 'run.completed' },
      { ...base, type: 'run.failed', failure: { code: 'X', message: 'boom', retryable: true } },
      { ...base, type: 'run.cancelled' },
    ];
    for (const v of variants)
      expect(HarnessEventSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
  });
  it('rejects missing type, wrong payload and unknown schema version', () => {
    const { type: _unusedType, ...noType } = { ...base, type: 'run.started' };
    void _unusedType;
    expect(HarnessEventSchema.safeParse(noType).success).toBe(false);
    expect(
      HarnessEventSchema.safeParse({ ...base, type: 'run.failed', failure: { message: 'x' } })
        .success,
    ).toBe(false);
    expect(
      HarnessEventSchema.safeParse({ ...base, type: 'run.started', schemaVersion: 99 }).success,
    ).toBe(false);
  });
  it('rejects redundant event-level identifiers and costs', () => {
    expect(
      HarnessEventSchema.safeParse({
        ...base,
        type: 'finding.submitted',
        findingId: finding.id,
        finding,
      }).success,
    ).toBe(false);
    expect(
      HarnessEventSchema.safeParse({
        ...base,
        type: 'evidence.submitted',
        evidenceId: evidence.id,
        evidence,
      }).success,
    ).toBe(false);
    expect(
      HarnessEventSchema.safeParse({
        ...base,
        type: 'usage.updated',
        usage: { estimatedCostUsd: 0.25 },
        estimatedCostUsd: 0.5,
      }).success,
    ).toBe(false);
  });
  it('golden NDJSON streams decode and order correctly', () => {
    const dir = join(__dirname, 'fixtures', 'harness');
    const ok = decodeEventsNdjson(readFileSync(join(dir, 'sample-success.ndjson'), 'utf8'));
    expect(eventTypes(ok)).toEqual([
      'run.started',
      'agent.status',
      'investigation.plan.created',
      'agent.status',
      'tool.started',
      'tool.completed',
      'test.result',
      'evidence.submitted',
      'finding.submitted',
      'usage.updated',
      'run.completed',
    ]);
    expect(
      HarnessEventSchema.safeParse(ok.find((e) => e.type === 'finding.submitted')).success,
    ).toBe(true);
    const fail = decodeEventsNdjson(readFileSync(join(dir, 'sample-failure.ndjson'), 'utf8'));
    expect(eventTypes(fail)).toEqual(['run.started', 'run.failed']);
    const cancelled = decodeEventsNdjson(
      readFileSync(join(dir, 'sample-cancelled.ndjson'), 'utf8'),
    );
    expect(eventTypes(cancelled)).toEqual(['run.started', 'run.cancelled']);
    validateHarnessEventSequence(ok);
    validateHarnessEventSequence(fail);
    validateHarnessEventSequence(cancelled);
    const transportLoss = decodeEventsNdjson(
      readFileSync(join(dir, 'sample-transport-loss.ndjson'), 'utf8'),
    );
    expect(eventTypes(transportLoss)).toEqual(['run.started', 'agent.status']);
    expect(() => validateHarnessEventSequence(transportLoss)).toThrowError(
      expect.objectContaining({ code: 'INVALID_EVENT_SEQUENCE' }),
    );
  });

  it.each([
    [[{ ...base, type: 'run.completed' }]],
    [[{ ...base, type: 'run.started' }]],
    [
      [
        { ...base, type: 'run.started' },
        { ...base, type: 'run.started' },
        { ...base, type: 'run.completed' },
      ],
    ],
    [
      [
        { ...base, type: 'run.started' },
        { ...base, type: 'run.failed', failure: { code: 'X', message: 'x' } },
        { ...base, type: 'run.completed' },
      ],
    ],
    [
      [
        { ...base, type: 'run.started' },
        { ...base, type: 'run.completed' },
        { ...base, type: 'warning', message: 'late' },
      ],
    ],
    [
      [
        { ...base, type: 'run.started' },
        { ...base, agentRunId: 'arun_01K7777777777777777777A8W5', type: 'run.completed' },
      ],
    ],
  ])('rejects an invalid lifecycle: %j', (rawEvents) => {
    const events = rawEvents.map((event) => HarnessEventSchema.parse(event));
    expect(() => validateHarnessEventSequence(events)).toThrow(HarnessProtocolError);
  });

  it('rejects nested AgentRun and requested QARun mismatches', () => {
    const mismatchedFinding = FindingSchema.parse({
      ...finding,
      agentRunId: 'arun_01K7777777777777777777A8W5',
    });
    const events = [
      HarnessEventSchema.parse({ ...base, type: 'run.started' }),
      HarnessEventSchema.parse({
        ...base,
        type: 'finding.submitted',
        finding: mismatchedFinding,
      }),
      HarnessEventSchema.parse({ ...base, type: 'run.completed' }),
    ];
    expect(() => validateHarnessEventSequence(events)).toThrowError(
      expect.objectContaining({ code: 'AGENT_RUN_MISMATCH' }),
    );
    expect(() =>
      validateHarnessEventSequence(
        [
          HarnessEventSchema.parse({ ...base, type: 'run.started' }),
          HarnessEventSchema.parse({ ...base, type: 'evidence.submitted', evidence }),
          HarnessEventSchema.parse({ ...base, type: 'run.completed' }),
        ],
        { qaRunId: 'run_01K7777777777777777777A8W6' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'QA_RUN_MISMATCH' }));
  });

  it('correlates tool operation pairs and rejects mismatches', () => {
    const valid = [
      HarnessEventSchema.parse({ ...base, type: 'run.started' }),
      HarnessEventSchema.parse({
        ...base,
        type: 'tool.started',
        operationId,
        tool: { name: 'shell' },
      }),
      HarnessEventSchema.parse({
        ...base,
        type: 'tool.completed',
        operationId,
        tool: { name: 'shell', exitCode: 0 },
      }),
      HarnessEventSchema.parse({ ...base, type: 'run.completed' }),
    ];
    expect(() => validateHarnessEventSequence(valid)).not.toThrow();
    const mismatched = valid.map((event) =>
      event.type === 'tool.completed'
        ? HarnessEventSchema.parse({ ...event, operationId: 'op_01K7777777777777777777A8WZ' })
        : event,
    );
    expect(() => validateHarnessEventSequence(mismatched)).toThrow(HarnessProtocolError);
    expect(HarnessEventSchema.safeParse({ ...base, type: 'warning', message: 'x' }).success).toBe(
      true,
    );
    expect(
      HarnessEventSchema.safeParse({
        ...base,
        type: 'tool.started',
        operationId: 'evt_01K7777777777777777777A8WX',
        tool: { name: 'shell' },
      }).success,
    ).toBe(false);
  });

  it('rejects investigation payload identity mismatches', () => {
    const events = [
      HarnessEventSchema.parse({ ...base, type: 'run.started' }),
      HarnessEventSchema.parse({
        ...base,
        type: 'investigation.plan.created',
        plan: { ...plan, agentRunId: 'arun_01K7777777777777777777A8W5' },
      }),
      HarnessEventSchema.parse({ ...base, type: 'run.completed' }),
    ];
    expect(() => validateHarnessEventSequence(events, { qaRunId: plan.qaRunId })).toThrowError(
      expect.objectContaining({ code: 'AGENT_RUN_MISMATCH' }),
    );
    const qaMismatch = [
      HarnessEventSchema.parse({ ...base, type: 'run.started' }),
      HarnessEventSchema.parse({
        ...base,
        type: 'investigation.plan.created',
        plan: { ...plan, qaRunId: 'run_01K7777777777777777777A8WX' },
      }),
      HarnessEventSchema.parse({ ...base, type: 'run.completed' }),
    ];
    expect(() => validateHarnessEventSequence(qaMismatch, { qaRunId: plan.qaRunId })).toThrowError(
      expect.objectContaining({ code: 'QA_RUN_MISMATCH' }),
    );
  });

  it('uses bounded protocol errors for malformed NDJSON and events', () => {
    expect(() => decodeEventsNdjson('{secret: definitely-not-json}')).toThrowError(
      expect.objectContaining({ code: 'INVALID_NDJSON', message: 'Invalid NDJSON on line 1' }),
    );
    expect(() => decodeEventsNdjson('{"type":"run.started"}')).toThrowError(
      expect.objectContaining({ code: 'INVALID_HARNESS_EVENT' }),
    );
    try {
      decodeEventsNdjson('{secret: definitely-not-json}');
    } catch (error) {
      expect((error as Error).message).not.toContain('definitely-not-json');
      expect(JSON.stringify((error as HarnessProtocolError).toJSON())).not.toContain(
        'definitely-not-json',
      );
    }
  });

  it('validates identities and tool lifecycle incrementally without event history', () => {
    const validator = new IncrementalHarnessEventValidator(finding.qaRunId, finding.agentRunId);
    validator.accept(HarnessEventSchema.parse({ ...base, type: 'run.started' }));
    validator.accept(
      HarnessEventSchema.parse({
        ...base,
        type: 'tool.started',
        operationId,
        tool: { name: 'shell' },
      }),
    );
    expect(() =>
      validator.accept(
        HarnessEventSchema.parse({
          ...base,
          type: 'tool.completed',
          operationId,
          tool: { name: 'browser' },
        }),
      ),
    ).toThrow(HarnessProtocolError);

    const ownership = new IncrementalHarnessEventValidator(finding.qaRunId, finding.agentRunId);
    ownership.accept(HarnessEventSchema.parse({ ...base, type: 'run.started' }));
    expect(() =>
      ownership.accept(
        HarnessEventSchema.parse({
          ...base,
          type: 'finding.submitted',
          finding: { ...finding, qaRunId: 'run_01K7777777777777777777A8WX' },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'QA_RUN_MISMATCH' }));
    expect(() =>
      ownership.accept(
        HarnessEventSchema.parse({
          ...base,
          agentRunId: 'arun_01K7777777777777777777A8W5',
          type: 'warning',
          message: 'wrong worker',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'AGENT_RUN_MISMATCH' }));

    const duplicateTool = new IncrementalHarnessEventValidator(finding.qaRunId, finding.agentRunId);
    duplicateTool.accept(HarnessEventSchema.parse({ ...base, type: 'run.started' }));
    const started = HarnessEventSchema.parse({
      ...base,
      type: 'tool.started',
      operationId,
      tool: { name: 'shell' },
    });
    duplicateTool.accept(started);
    expect(() => duplicateTool.accept(started)).toThrow(HarnessProtocolError);
  });

  it('rejects events after terminal and requires a terminal on stream close', () => {
    const validator = new IncrementalHarnessEventValidator(finding.qaRunId, finding.agentRunId);
    validator.accept(HarnessEventSchema.parse({ ...base, type: 'run.started' }));
    expect(() => validator.finish()).toThrow(HarnessProtocolError);
    validator.accept(HarnessEventSchema.parse({ ...base, type: 'run.completed' }));
    expect(() =>
      validator.accept(HarnessEventSchema.parse({ ...base, type: 'warning', message: 'late' })),
    ).toThrow(HarnessProtocolError);
  });
});
