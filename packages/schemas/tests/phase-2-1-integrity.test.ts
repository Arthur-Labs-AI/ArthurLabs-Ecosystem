import { describe, expect, it } from 'vitest';
import {
  ManagedProjectCopySchema,
  ProjectSnapshotSchema,
  QARunSchema,
  RuntimeInstanceSchema,
  RuntimeOperationSchema,
  SnapshotFileEntrySchema,
} from '../src/index.js';

const timestamp = '2026-09-11T00:00:00.000Z';

describe('Phase 2.1 runtime integrity contracts', () => {
  it('validates durable runtime instances and filesystem operations', () => {
    expect(
      RuntimeInstanceSchema.parse({
        schemaVersion: 1,
        id: 'runtime_01K7777777777777777777C001',
        processId: 123,
        hostname: 'test-host',
        startedAt: timestamp,
        heartbeatAt: timestamp,
      }),
    ).toBeDefined();
    expect(
      RuntimeOperationSchema.parse({
        schemaVersion: 1,
        id: 'op_01K7777777777777777777C002',
        projectId: 'proj_01K7777777777777777777A8W1',
        runtimeInstanceId: 'runtime_01K7777777777777777777C001',
        type: 'project_update',
        stage: 'preparing',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toBeDefined();
  });

  it('requires ownership while a managed copy is actively mutating', () => {
    expect(
      ManagedProjectCopySchema.safeParse({
        schemaVersion: 1,
        projectId: 'proj_01K7777777777777777777A8W1',
        currentRevisionId: 'rev_01K7777777777777777777A8W9',
        state: 'updating',
        updatedAt: timestamp,
      }).success,
    ).toBe(false);
    expect(
      ManagedProjectCopySchema.safeParse({
        schemaVersion: 1,
        projectId: 'proj_01K7777777777777777777A8W1',
        currentRevisionId: 'rev_01K7777777777777777777A8W9',
        state: 'deleting',
        runtimeInstanceId: 'runtime_01K7777777777777777777C001',
        updatedAt: timestamp,
      }).success,
    ).toBe(true);
  });

  it('records run ownership and complete symlink identity', () => {
    const run = QARunSchema.parse({
      schemaVersion: 1,
      id: 'run_01K7777777777777777777A8W3',
      projectId: 'proj_01K7777777777777777777A8W1',
      snapshotId: 'snap_01K7777777777777777777A8W2',
      projectContextSnapshotId: 'ctx_01K7777777777777777777A8WA',
      runtimeInstanceId: 'runtime_01K7777777777777777777C001',
      mode: 'full',
      status: 'agents_running',
      configuration: {
        agentStackIds: ['stack_muse_main'],
        verificationLevel: 'strict',
        policy: { id: 'qa-standard', version: 1 },
      },
      createdAt: timestamp,
    });
    expect(run.runtimeInstanceId).toContain('runtime_');
    const link = SnapshotFileEntrySchema.parse({
      relativePath: 'shared-link',
      type: 'symlink',
      sizeBytes: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      linkTarget: '../shared',
      linkScope: 'internal',
    });
    expect(link.linkScope).toBe('internal');
    expect(
      ProjectSnapshotSchema.safeParse({
        schemaVersion: 1,
        id: 'snap_01K7777777777777777777A8W2',
        projectId: run.projectId,
        projectRevisionId: 'rev_01K7777777777777777777A8W9',
        createdAt: timestamp,
        sourceState: {},
        manifest: {
          entryCount: 0,
          fileCount: 0,
          directoryCount: 0,
          symlinkCount: 0,
          totalBytes: 0,
          artifactId: 'artifact_01K7777777777777777777A8WE',
        },
        contentHash: link.sha256,
      }).success,
    ).toBe(true);
  });
});
