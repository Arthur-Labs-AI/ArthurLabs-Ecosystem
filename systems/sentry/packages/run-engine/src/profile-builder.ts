import { composeProfileText } from '@qa/evidence-pipeline';
import type { HarnessAdapterRegistry } from '@qa/harness-protocol';
import { rm } from 'node:fs/promises';
import {
  ProjectProfileStore,
  projectDataPaths,
  runDataPaths,
  type SentryRepository,
} from '@qa/persistence';
import type { ProjectManager } from '@qa/project-manager';
import {
  HarnessRunRequestSchema,
  ProjectProfileSchema,
  type ProjectProfile,
  type ProjectRevision,
} from '@qa/schemas';
import {
  createAgentRunId,
  createQARunId,
  createSnapshotId,
  nowIsoTimestamp,
  type AgentStackId,
  type ProjectId,
} from '@qa/shared';
import type { WorkspaceFactory } from '@qa/workspace-factory';
import { RunEngineError } from './errors.js';

/** One agent writes its notes in a single planning turn; this is the longest it may take. */
export const PROFILE_TIMEOUT_MS = 20 * 60_000;

export type ProfileState = 'none' | 'fresh' | 'stale';

export interface ProfileStatus {
  readonly agentStackId: AgentStackId;
  readonly state: ProfileState;
  readonly createdAt?: string;
  readonly text?: string;
}

/** A profile describes exactly one revision; any other content hash makes it stale. */
export function profileState(
  profile: ProjectProfile | undefined,
  revision: Pick<ProjectRevision, 'contentHash'>,
): ProfileState {
  if (profile === undefined) return 'none';
  return profile.contentHash === revision.contentHash ? 'fresh' : 'stale';
}

/**
 * "Get to know the project": one agent reads the project in a private workspace
 * and writes its own orientation notes. No QA run exists, nothing is persisted
 * apart from the notes, and the planning turn is the only turn taken.
 */
export class ProjectProfileBuilder {
  readonly store: ProjectProfileStore;

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
    private readonly projects: ProjectManager,
    private readonly workspaces: WorkspaceFactory,
    private readonly registry: HarnessAdapterRegistry,
    private readonly timeoutMs = PROFILE_TIMEOUT_MS,
  ) {
    this.store = new ProjectProfileStore(dataRoot);
  }

  async status(projectId: ProjectId): Promise<ProfileStatus[]> {
    const record = this.projects.getProject(projectId);
    if (record === undefined)
      throw new RunEngineError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
    return Promise.all(
      this.registry.list().map(async ({ stack }) => {
        const profile = await this.store.read(projectId, stack.id);
        const state = profileState(profile, record.revision);
        return {
          agentStackId: stack.id,
          state,
          ...(profile === undefined ? {} : { createdAt: profile.createdAt, text: profile.text }),
        };
      }),
    );
  }

  async build(
    projectId: ProjectId,
    agentStackId: AgentStackId,
    signal?: AbortSignal,
  ): Promise<ProjectProfile> {
    const registration = this.registry.resolve(agentStackId);
    if (registration === undefined)
      throw new RunEngineError('AGENT_STACK_NOT_FOUND', 'Agent stack not found: ' + agentStackId);
    const record = this.projects.getProject(projectId);
    if (record === undefined)
      throw new RunEngineError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
    if (!['ready', 'locked_for_run'].includes(record.managedCopy.state))
      throw new RunEngineError(
        'PROJECT_NOT_READY',
        'The project is being changed (' +
          record.managedCopy.state +
          '); try again when it is ready.',
      );
    const context = record.context ?? this.repository.getContextForRevision(record.revision.id);
    if (context === undefined)
      throw new RunEngineError('PROJECT_NOT_FOUND', 'Project context is missing.');
    await registration.preflight?.();
    const revision = await this.projects.assertWorkingCopyIntegrity(projectId);
    const resolvedModelId = registration.runtimeIdentity?.modelId;
    const stack =
      resolvedModelId === undefined
        ? registration.stack
        : {
            ...registration.stack,
            model: { ...registration.stack.model, modelId: resolvedModelId },
          };

    // Ids only name the private workspace and the request; no run row is ever written for them.
    const qaRunId = createQARunId();
    const agentRunId = createAgentRunId();
    const snapshotId = createSnapshotId();
    const workingCopy = projectDataPaths(this.dataRoot, projectId).workingCopy;
    const workspace = await this.workspaces.create({
      projectId,
      qaRunId,
      agentRunId,
      snapshotId,
      workingCopyPath: workingCopy,
      ...(signal === undefined ? {} : { signal }),
    });
    const adapter = await registration.createAdapter({ qaRunId, agentRunId, agentIndex: 0, stack });
    const timer = setTimeout(
      () => void adapter.cancel(agentRunId).catch(() => undefined),
      this.timeoutMs,
    );
    const onAbort = () => void adapter.cancel(agentRunId).catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const request = HarnessRunRequestSchema.parse({
        schemaVersion: 1,
        agentRunId,
        qaRunId,
        agentStackId: stack.id,
        projectContextSnapshotId: context.id,
        workspace,
        model: stack.model,
        task: {
          type: 'qa',
          prompt: 'PROJECT PROFILE. Write orientation notes only.',
          policyId: stack.policy.id,
          policyVersion: stack.policy.version,
          context: { profileOnly: true, agentStack: stack },
        },
      });
      let plan: { projectUnderstanding: string; criticalFlows?: string[] } | undefined;
      let failure: string | undefined;
      for await (const event of adapter.run(request)) {
        if (event.type === 'investigation.plan.created') {
          plan = event.plan;
          break; // the planning turn is all a profile needs; leaving the loop ends the session
        }
        if (event.type === 'run.failed') {
          failure = event.failure.message;
          break;
        }
      }
      if (plan === undefined)
        throw new RunEngineError(
          'PROFILE_FAILED',
          failure ??
            (signal?.aborted === true
              ? 'Profile building was cancelled.'
              : 'The agent wrote no profile.'),
        );
      // The notes describe the copy that was read: refuse them if the project moved on meanwhile.
      const after = this.projects.getProject(projectId);
      if (after === undefined || after.revision.contentHash !== revision.contentHash)
        throw new RunEngineError(
          'PROFILE_FAILED',
          'The project changed while the profile was written; build it again.',
        );
      const profile = ProjectProfileSchema.parse({
        schemaVersion: 1,
        projectId,
        agentStackId: stack.id,
        projectRevisionId: revision.id,
        contentHash: revision.contentHash,
        text: composeProfileText(plan),
        createdAt: nowIsoTimestamp(),
      });
      await this.store.write(profile);
      return profile;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await adapter.cancel(agentRunId).catch(() => undefined);
      await adapter.dispose().catch(() => undefined);
      await this.workspaces.cleanup(workspace);
      // The synthetic run folder exists only for this build.
      await rm(runDataPaths(this.dataRoot, projectId, qaRunId).root, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}
