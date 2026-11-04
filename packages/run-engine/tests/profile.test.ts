import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { HarnessAdapterRegistry, type HarnessAdapter } from '@qa/harness-protocol';
import {
  projectDataPaths,
  RuntimeInstanceLease,
  SentryDatabase,
  SentryRepository,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import type { HarnessEvent, HarnessRunRequest } from '@qa/schemas';
import { createHarnessEventId, nowIsoTimestamp } from '@qa/shared';
import { createFakeHarnessRegistry, profileState, RunCoordinator } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const stack = INITIAL_AGENT_STACKS[0]!;

/** An agent that writes profile notes in its planning turn and would keep working afterwards. */
function notesAdapter(
  notes: { understanding: string; flows: string[] },
  seen: HarnessRunRequest[],
  state: { finished: boolean },
): HarnessAdapter {
  return {
    getMetadata: async () => ({ adapterId: 'notes', adapterVersion: '1' }) as never,
    healthCheck: async () => ({ ok: true }) as never,
    async *run(request) {
      seen.push(request);
      try {
        yield {
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId: request.agentRunId,
          timestamp: nowIsoTimestamp(),
          type: 'investigation.plan.created',
          plan: {
            projectUnderstanding: notes.understanding,
            criticalFlows: notes.flows,
            weakPoints: [],
            plannedChecks: ['profile'],
          },
        } as unknown as HarnessEvent;
        // Anything after the plan must never run: the builder stops at the first plan.
        state.finished = true;
        yield { type: 'run.completed' } as unknown as HarnessEvent;
      } finally {
        // cleanup runs when the consumer leaves early
      }
    },
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
}

async function fixture(registry?: HarnessAdapterRegistry) {
  const root = await mkdtemp(join(tmpdir(), 'sentry-profile-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  await writeFile(join(source, 'src', 'main.ts'), 'export const main = 1;\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  const runs = new RunCoordinator(
    dataRoot,
    repository,
    lease,
    registry ?? createFakeHarnessRegistry('success'),
  );
  return { dataRoot, database, added, runs, manager };
}

function notesRegistry(seen: HarnessRunRequest[], state: { finished: boolean }) {
  const registry = new HarnessAdapterRegistry();
  registry.register({
    stack,
    runtimeIdentity: { modelId: stack.model.modelId, adapterId: 'notes', adapterVersion: '1' },
    createAdapter: () =>
      notesAdapter(
        { understanding: 'A CLI that reads README.md.', flows: ['src/main.ts starts it'] },
        seen,
        state,
      ),
  });
  return registry;
}

describe('project profile', () => {
  it('judges freshness by the revision content hash only', () => {
    const profile = { contentHash: 'sha256:a' } as never;
    expect(profileState(undefined, { contentHash: 'sha256:a' })).toBe('none');
    expect(profileState(profile, { contentHash: 'sha256:a' })).toBe('fresh');
    expect(profileState(profile, { contentHash: 'sha256:b' })).toBe('stale');
  });

  it('builds one agent profile from its planning turn and cleans up after itself', async () => {
    const seen: HarnessRunRequest[] = [];
    const state = { finished: false };
    const f = await fixture(notesRegistry(seen, state));
    const profile = await f.runs.profiles.build(f.added.project.id, stack.id);
    expect(profile.text).toContain('A CLI that reads README.md.');
    expect(profile.text).toContain('- src/main.ts starts it');
    expect(profile.contentHash).toBe(f.added.revision.contentHash);
    expect(seen[0]?.task.context?.['profileOnly']).toBe(true);
    expect(state.finished).toBe(false);
    const status = await f.runs.profiles.status(f.added.project.id);
    expect(status).toEqual([
      expect.objectContaining({ agentStackId: stack.id, state: 'fresh', text: profile.text }),
    ]);
    // No run was created and the private workspace is gone.
    expect(f.runs.listRuns?.(f.added.project.id) ?? []).toEqual([]);
    const runsDir = projectDataPaths(f.dataRoot, f.added.project.id).runs;
    expect(await readdir(runsDir).catch(() => [])).toEqual([]);
    f.database.close();
  });

  it('fails clearly when the agent never writes a plan', async () => {
    const registry = new HarnessAdapterRegistry();
    registry.register({
      stack,
      runtimeIdentity: { modelId: stack.model.modelId },
      createAdapter: () =>
        ({
          getMetadata: async () => ({}) as never,
          healthCheck: async () => ({}) as never,
          async *run(request: HarnessRunRequest) {
            yield {
              schemaVersion: 1,
              eventId: createHarnessEventId(),
              agentRunId: request.agentRunId,
              timestamp: nowIsoTimestamp(),
              type: 'run.failed',
              failure: { code: 'X', message: 'provider is down', retryable: false },
            } as unknown as HarnessEvent;
          },
          cancel: async () => undefined,
          dispose: async () => undefined,
        }) as HarnessAdapter,
    });
    const f = await fixture(registry);
    await expect(f.runs.profiles.build(f.added.project.id, stack.id)).rejects.toMatchObject({
      code: 'PROFILE_FAILED',
      message: 'provider is down',
    });
    expect((await f.runs.profiles.status(f.added.project.id))[0]?.state).toBe('none');
    f.database.close();
  });

  it('hands a fresh profile only to its own agent and records what happened', async () => {
    const seen: HarnessRunRequest[] = [];
    const f = await fixture();
    await f.runs.profiles.store.write({
      schemaVersion: 1,
      projectId: f.added.project.id,
      agentStackId: INITIAL_AGENT_STACKS[0]!.id,
      projectRevisionId: f.added.revision.id,
      contentHash: f.added.revision.contentHash,
      text: 'MY NOTES',
      createdAt: nowIsoTimestamp(),
    });
    await f.runs.profiles.store.write({
      schemaVersion: 1,
      projectId: f.added.project.id,
      agentStackId: INITIAL_AGENT_STACKS[1]!.id,
      projectRevisionId: f.added.revision.id,
      contentHash: 'sha256:old',
      text: 'OLD NOTES',
      createdAt: nowIsoTimestamp(),
    });
    const withProfile = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      useProfile: true,
      onHarnessRequest: (request) => seen.push(request),
    });
    const entry = (request: HarnessRunRequest) => request.task.context?.['projectProfile'];
    const mine = seen.find((r) => r.agentStackId === INITIAL_AGENT_STACKS[0]!.id);
    const stale = seen.find((r) => r.agentStackId === INITIAL_AGENT_STACKS[1]!.id);
    const missing = seen.find((r) => r.agentStackId === INITIAL_AGENT_STACKS[2]!.id);
    expect(JSON.stringify(entry(mine!))).toContain('MY NOTES');
    expect(JSON.stringify(entry(mine!))).toContain('UNVERIFIED');
    expect(entry(stale!)).toBeUndefined();
    expect(entry(missing!)).toBeUndefined();
    expect(withProfile.run.configuration.profileUsage).toEqual({
      requested: true,
      usedAgentStackIds: [INITIAL_AGENT_STACKS[0]!.id],
      staleAgentStackIds: [INITIAL_AGENT_STACKS[1]!.id],
      missingAgentStackIds: [INITIAL_AGENT_STACKS[2]!.id],
    });

    seen.length = 0;
    const without = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      onHarnessRequest: (request) => seen.push(request),
    });
    expect(seen.every((r) => entry(r) === undefined)).toBe(true);
    expect(without.run.configuration.profileUsage?.requested).toBe(false);
    expect(without.run.configuration.profileUsage?.usedAgentStackIds).toEqual([]);
    f.database.close();
  });
});
