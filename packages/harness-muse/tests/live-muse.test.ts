import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { HarnessRunRequestSchema } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import { MuseHarnessAdapter } from '../src/index.js';

const liveEnabled = process.env.SENTRY_LIVE_MUSE_TEST === '1';

describe.skipIf(!liveEnabled)('live Muse smoke (explicit network/cost opt-in)', () => {
  it('completes a two-stage structured investigation in an isolated fixture', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'sentry-live-muse-'));
    try {
      await writeFile(
        join(workspace, 'README.md'),
        '# Live Muse smoke\nThis fixture is intentionally small.\n',
      );
      const request = HarnessRunRequestSchema.parse({
        schemaVersion: 1,
        agentRunId: createAgentRunId(),
        qaRunId: createQARunId(),
        agentStackId: 'stack_muse_main',
        projectContextSnapshotId: createProjectContextSnapshotId(),
        workspace: {
          runtimePath: workspace,
          snapshotId: createSnapshotId(),
          writable: true,
          isolated: true,
        },
        model: { provider: 'meta', modelId: process.env.SENTRY_MUSE_MODEL },
        task: {
          type: 'qa',
          prompt: 'Inspect this tiny documentation-only fixture.',
          policyId: 'qa-standard',
          policyVersion: 1,
        },
        executionSafeguards: { runTimeoutMs: 300_000 },
      });
      const adapter = new MuseHarnessAdapter();
      const eventTypes: string[] = [];
      for await (const event of adapter.run(request)) eventTypes.push(event.type);
      await adapter.dispose();
      expect(eventTypes).toContain('investigation.plan.created');
      expect(eventTypes.at(-1)).toBe('run.completed');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 600_000);
});
