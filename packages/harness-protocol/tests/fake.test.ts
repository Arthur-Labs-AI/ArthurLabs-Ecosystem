import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceSchema,
  FindingSchema,
  HarnessEventSchema,
  HarnessRunRequestSchema,
} from '@qa/schemas';
import {
  collectEvents,
  eventTypes,
  FakeHarnessAdapter,
  validateHarnessEventSequence,
} from '../src/index.js';

const request = HarnessRunRequestSchema.parse({
  schemaVersion: 1,
  agentRunId: 'arun_01K7777777777777777777A8W4',
  qaRunId: 'run_01K7777777777777777777A8W3',
  workspace: {
    runtimePath: '/tmp/qa-work',
    snapshotId: 'snap_01K7777777777777777777A8W2',
    writable: false,
  },
  model: { provider: 'future-ai', modelId: 'future-model-v9' },
  task: { type: 'qa', prompt: 'Analyze this snapshot.', policyId: 'qa-standard', policyVersion: 1 },
});

const fixDir = join(__dirname, '..', '..', 'domain', 'tests', 'fixtures');
const finding = FindingSchema.parse(JSON.parse(readFileSync(join(fixDir, 'finding.json'), 'utf8')));
const evidence = EvidenceSchema.parse(
  JSON.parse(readFileSync(join(fixDir, 'evidence.json'), 'utf8')),
);

describe('FakeHarnessAdapter', () => {
  it('exposes protocol v1 metadata and healthy status', async () => {
    const fake = new FakeHarnessAdapter();
    expect((await fake.getMetadata()).protocolVersion).toBe(1);
    expect((await fake.healthCheck()).status).toBe('healthy');
    await fake.dispose();
  });
  it('success scenario yields a valid completed stream', async () => {
    const events = await collectEvents(
      new FakeHarnessAdapter({ scenario: 'success', finding, evidence }).run(request),
    );
    expect(eventTypes(events)[0]).toBe('run.started');
    expect(eventTypes(events).at(-1)).toBe('run.completed');
    for (const e of events) expect(HarnessEventSchema.safeParse(e).success).toBe(true);
    validateHarnessEventSequence(events, {
      agentRunId: request.agentRunId,
      qaRunId: request.qaRunId,
    });
  });
  it('finding scenario submits the finding; evidence scenario submits evidence', async () => {
    const f = await collectEvents(
      new FakeHarnessAdapter({ scenario: 'finding', finding }).run(request),
    );
    expect(eventTypes(f)).toContain('finding.submitted');
    const e = await collectEvents(
      new FakeHarnessAdapter({ scenario: 'evidence', evidence }).run(request),
    );
    expect(eventTypes(e)).toContain('evidence.submitted');
  });
  it('failure and cancellation scenarios terminate correctly', async () => {
    const fail = await collectEvents(new FakeHarnessAdapter({ scenario: 'failure' }).run(request));
    expect(eventTypes(fail).at(-1)).toBe('run.failed');
    const fake = new FakeHarnessAdapter({ scenario: 'success' });
    await fake.cancel(request.agentRunId);
    const cancelled = await collectEvents(fake.run(request));
    expect(eventTypes(cancelled).at(-1)).toBe('run.cancelled');
    for (const events of [fail, cancelled]) {
      for (const event of events) expect(HarnessEventSchema.safeParse(event).success).toBe(true);
      validateHarnessEventSequence(events);
    }
  });
  it('cancels only the requested AgentRun when an adapter instance is reused', async () => {
    const fake = new FakeHarnessAdapter();
    await fake.cancel(request.agentRunId);
    const otherRequest = HarnessRunRequestSchema.parse({
      ...request,
      agentRunId: 'arun_01K7777777777777777777A8W5',
    });
    expect(eventTypes(await collectEvents(fake.run(request))).at(-1)).toBe('run.cancelled');
    expect(eventTypes(await collectEvents(fake.run(otherRequest))).at(-1)).toBe('run.completed');
  });
});
