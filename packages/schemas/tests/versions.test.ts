import { describe, expect, it } from 'vitest';
import { FindingSchema, HarnessEventSchema, HarnessRunRequestSchema } from '../src/index.js';
import { ProjectSnapshotSchema, AgentStackDefinitionSchema } from '../src/index.js';

describe('schema versioning (strict Phase 1)', () => {
  it('rejects unknown schemaVersion on persisted structures', () => {
    const snap = {
      schemaVersion: 99,
      id: 'snap_01K7777777777777777777A8W2',
      projectId: 'proj_01K7777777777777777777A8W1',
      createdAt: '2026-09-09T19:00:00.000Z',
      sourceState: {},
      manifest: { entries: [] },
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    expect(ProjectSnapshotSchema.safeParse(snap).success).toBe(false);
  });
  it('rejects unknown schemaVersion on events and requests', () => {
    const evt = {
      schemaVersion: 99,
      eventId: 'evt_01K7777777777777777777A8WX',
      agentRunId: 'arun_01K7777777777777777777A8W4',
      timestamp: '2026-09-09T19:00:00.000Z',
      type: 'run.started',
    };
    expect(HarnessEventSchema.safeParse(evt).success).toBe(false);
    const req = {
      schemaVersion: 99,
      agentRunId: 'arun_01K7777777777777777777A8W4',
      qaRunId: 'run_01K7777777777777777777A8W3',
      workspace: {
        runtimePath: '/tmp/w',
        snapshotId: 'snap_01K7777777777777777777A8W2',
        writable: false,
      },
      model: { provider: 'x', modelId: 'y' },
      task: { type: 'qa', prompt: 'hi', policyId: 'qa-standard', policyVersion: 1 },
    };
    expect(HarnessRunRequestSchema.safeParse(req).success).toBe(false);
  });
  it('accepts current version across the board', () => {
    expect(
      AgentStackDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: 'stack_x',
        displayName: 'X',
        enabled: true,
        model: { provider: 'p', modelId: 'm' },
        harness: { adapterId: 'h', expectedProtocolVersion: 1 },
        execution: {},
        policy: { id: 'qa-standard', version: 1 },
      }).success,
    ).toBe(true);
    expect(
      FindingSchema.safeParse({
        schemaVersion: 1,
        id: 'find_01K7777777777777777777A8W7',
        qaRunId: 'run_01K7777777777777777777A8W3',
        agentRunId: 'arun_01K7777777777777777777A8W4',
        sourceAgentStackId: 'stack_x',
        title: 't',
        category: 'logic',
        severity: 'low',
        confidence: 'probable',
        description: 'd',
        locations: [{ relativePath: 'a.ts' }],
        evidenceIds: [],
        reproductionSteps: [],
        createdAt: '2026-09-09T19:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
