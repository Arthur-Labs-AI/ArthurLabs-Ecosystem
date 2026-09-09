import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceSchema, FindingSchema, HarnessEventSchema } from '@qa/schemas';
import { decodeEventsNdjson, eventTypes } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const base = {
  schemaVersion: 1,
  eventId: 'evt_01K7777777777777777777A8WX',
  agentRunId: 'arun_01K7777777777777777777A8W4',
  timestamp: T,
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
      { ...base, type: 'tool.started', tool: { name: 'shell' } },
      { ...base, type: 'tool.completed', tool: { name: 'shell', exitCode: 0 } },
      { ...base, type: 'command.executed', command: 'npm test', exitCode: 0 },
      { ...base, type: 'file.read', relativePath: 'src/a.ts' },
      { ...base, type: 'file.changed', relativePath: 'src/a.ts', operation: 'modify' },
      { ...base, type: 'test.result', passed: 3, failed: 0 },
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
  it('golden NDJSON streams decode and order correctly', () => {
    const dir = join(__dirname, 'fixtures', 'harness');
    const ok = decodeEventsNdjson(readFileSync(join(dir, 'sample-success.ndjson'), 'utf8'));
    expect(eventTypes(ok)).toEqual([
      'run.started',
      'agent.status',
      'tool.started',
      'tool.completed',
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
  });
});
