/**
 * Deterministic run-graph builder: RunWorkspaceView → React Flow nodes/edges.
 * Same run state always produces the same graph. Topology is Sentry-owned;
 * node positions are deterministic auto-layout (top → bottom with a
 * horizontal agent fan-out).
 */
import type { AgentNodeView, AgentRunLike, EvidenceLike, FindingLike, RunLike } from './types.js';
import { projectAgentTelemetry, AGENT_DISPLAY_NAMES } from './agent-telemetry.js';

export type RunNodeKind =
  | 'project'
  | 'revision'
  | 'snapshot'
  | 'target'
  | 'agent'
  | 'merger'
  | 'verifier'
  | 'issues'
  | 'retest-source'
  | 'retest-spec'
  | 'retest-assessment';

export interface RunGraphNode {
  readonly id: string;
  readonly kind: RunNodeKind;
  readonly label: string;
  readonly status: string;
  readonly position: { x: number; y: number };
  readonly data: Record<string, unknown>;
}

export interface RunGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly state: 'pending' | 'active' | 'completed' | 'blocked' | 'failed';
}

export interface RunWorkspaceInput {
  readonly run: RunLike;
  /** True when an idempotent issue-ingest marker was observed (honest zero-issue ingest). */
  readonly ingestRan?: boolean;
  readonly agentRuns: readonly AgentRunLike[];
  readonly findings: readonly FindingLike[];
  readonly evidence: readonly EvidenceLike[];
  readonly eventsByAgent?: Readonly<
    Record<string, readonly { type: string; agentRunId: string; timestamp: string }[]>
  >;
  readonly activitiesByAgent?: Readonly<
    Record<
      string,
      readonly { id: string; kind: string; status: string; title: string; startedAt?: string }[]
    >
  >;
  readonly targetSpec?: { includePaths?: readonly string[]; userInstructions?: string } | undefined;
  readonly mergeResults?:
    | readonly {
        id: string;
        mergerVersion?: number | undefined;
        normalizerVersion?: number | undefined;
        usableAgentRunIds?: readonly string[] | undefined;
        unavailableAgentStackIds?: readonly string[] | undefined;
        expectedAgentStackIds?: readonly string[] | undefined;
        clusters?:
          | readonly {
              id: string;
              agreementState?: string | undefined;
              supportingAgentCount?: number | undefined;
              usableAgentCount?: number | undefined;
              expectedAgentCount?: number | undefined;
              unavailableAgentStackIds?: readonly string[] | undefined;
              sourceAgentStackIds?: readonly string[] | undefined;
              sourceFindingIds?: readonly string[] | undefined;
              representativeFindingId?: string | undefined;
              severityValues?: readonly string[] | undefined;
              hasReproducedEvidence?: boolean | undefined;
            }[]
          | undefined;
      }[]
    | undefined;
  readonly verificationRuns?:
    | readonly {
        id: string;
        status: string;
        verifierVersion?: number | undefined;
        recipeVersion?: number | undefined;
        signatureVersion?: number | undefined;
        attempts?:
          | readonly {
              id?: string | undefined;
              findingClusterId?: string | undefined;
              status?: string | undefined;
              outcome?: string | undefined;
              matchStrength?: string | undefined;
              steps?:
                | readonly {
                    id?: string | undefined;
                    type?: string | undefined;
                    status?: string | undefined;
                    outcome?: string | undefined;
                    matchStrength?: string | undefined;
                  }[]
                | undefined;
              observations?: readonly unknown[] | undefined;
              assertions?:
                readonly { subject?: string | undefined; state?: string | undefined }[] | undefined;
            }[]
          | undefined;
      }[]
    | undefined;
  readonly findingsById?:
    | Readonly<Record<string, { title?: string | undefined; severity?: string | undefined }>>
    | undefined;
  readonly issueCount?: number;
  readonly agentDisplayNames?: Readonly<Record<string, string>>;
}

function edgeStateFor(status: string): RunGraphEdge['state'] {
  if (['completed', 'partial'].includes(status)) return 'completed';
  if (['failed'].includes(status)) return 'failed';
  if (['cancelled', 'interrupted'].includes(status)) return 'blocked';
  return 'active';
}

const TERMINAL_AGENT = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);

export function buildAgentViews(input: RunWorkspaceInput, now?: number): AgentNodeView[] {
  return input.agentRuns.map((agentRun) =>
    projectAgentTelemetry({
      agentRun,
      displayName:
        input.agentDisplayNames?.[agentRun.agentStackId] ??
        AGENT_DISPLAY_NAMES[agentRun.agentStackId] ??
        agentRun.agentStackId,
      events: (input.eventsByAgent?.[agentRun.id] ?? []) as never,
      activities: (input.activitiesByAgent?.[agentRun.id] ?? []) as never,
      findings: input.findings.filter((f) => f.agentRunId === agentRun.id),
      evidence: input.evidence.filter((e) => e.agentRunId === agentRun.id),
      ...(now === undefined ? {} : { now }),
    }),
  );
}

export function buildRunGraph(
  input: RunWorkspaceInput,
  now?: number,
): { nodes: RunGraphNode[]; edges: RunGraphEdge[]; agents: AgentNodeView[] } {
  const agents = buildAgentViews(input, now);
  const nodes: RunGraphNode[] = [];
  const edges: RunGraphEdge[] = [];
  const runStatus = input.run.status;

  const agentIds =
    input.run.configuration?.agentStackIds ?? input.agentRuns.map((a) => a.agentStackId);
  void agentIds;

  nodes.push({
    id: 'project',
    kind: 'project',
    label: 'Project',
    status: 'completed',
    position: { x: 340, y: 0 },
    data: { projectId: input.run.projectId },
  });
  nodes.push({
    id: 'revision',
    kind: 'revision',
    label: 'Revision',
    status: 'completed',
    position: { x: 340, y: 110 },
    data: {},
  });
  nodes.push({
    id: 'snapshot',
    kind: 'snapshot',
    label: 'Snapshot',
    status: 'completed',
    position: { x: 340, y: 220 },
    data: { snapshotId: input.run.snapshotId },
  });
  edges.push({
    id: 'e-project-revision',
    source: 'project',
    target: 'revision',
    state: 'completed',
  });
  edges.push({
    id: 'e-revision-snapshot',
    source: 'revision',
    target: 'snapshot',
    state: 'completed',
  });

  let fanSource = 'snapshot';
  if (input.run.mode === 'targeted') {
    nodes.push({
      id: 'target',
      kind: 'target',
      label: 'TargetSpec',
      status: 'completed',
      position: { x: 340, y: 330 },
      data: {
        includePaths: input.targetSpec?.includePaths ?? [],
        userInstructions: input.targetSpec?.userInstructions,
      },
    });
    edges.push({
      id: 'e-snapshot-target',
      source: 'snapshot',
      target: 'target',
      state: 'completed',
    });
    fanSource = 'target';
  }

  // Three parallel agent branches, evenly fanned. Missing AgentRuns render
  // as configured-but-waiting placeholders (§213-§214).
  const configuredStacks =
    input.run.configuration?.agentStackIds ?? input.agentRuns.map((a) => a.agentStackId);
  const stacksToRender =
    configuredStacks.length > 0
      ? configuredStacks
      : ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main'];
  const agentY = input.run.mode === 'targeted' ? 470 : 360;
  stacksToRender.forEach((stackId, index) => {
    const view = agents.find((a) => a.agentStackId === stackId);
    const nodeId = 'agent-' + stackId;
    const x = 40 + index * 260;
    nodes.push({
      id: nodeId,
      kind: 'agent',
      label: view?.displayName ?? AGENT_DISPLAY_NAMES[stackId] ?? stackId,
      status: view?.status ?? 'waiting',
      position: { x, y: agentY },
      data: { agentStackId: stackId, agentRunId: view?.agentRunId, view },
    });
    edges.push({
      id: 'e-' + fanSource + '-' + nodeId,
      source: fanSource,
      target: nodeId,
      state:
        view === undefined
          ? 'pending'
          : TERMINAL_AGENT.has(view.status)
            ? edgeStateFor(view.status)
            : 'active',
    });
  });

  const mergerY = agentY + 300;
  // Authoritative current MergeResult: highest supported mergerVersion.
  // Never rely on repository ordering ([0]); history stays viewable.
  const SUPPORTED_MERGER_VERSIONS = [1, 2, 3];
  const merge =
    input.mergeResults === undefined
      ? undefined
      : [...input.mergeResults]
          .filter(
            (m) =>
              m.mergerVersion === undefined || SUPPORTED_MERGER_VERSIONS.includes(m.mergerVersion),
          )
          .sort((a, b) => (b.mergerVersion ?? 0) - (a.mergerVersion ?? 0))[0];
  // Honest merger: COMPLETED only when a MergeResult exists. Terminal QARun
  // without one is NOT completed (agents terminal → ready, else waiting).
  const agentsTerminal =
    input.agentRuns.length > 0 &&
    input.agentRuns.every((a) =>
      ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(a.status),
    );
  const agentsActive = input.agentRuns.some(
    (a) => !['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(a.status),
  );
  const mergerStatus =
    merge !== undefined
      ? 'completed'
      : agentsActive
        ? 'waiting'
        : agentsTerminal
          ? 'ready'
          : 'waiting';
  void runStatus;
  const usableCount = merge?.usableAgentRunIds?.length;
  const expectedCount = merge?.expectedAgentStackIds?.length;
  nodes.push({
    id: 'merger',
    kind: 'merger',
    label: merge?.mergerVersion !== undefined ? 'Merger v' + merge.mergerVersion : 'Merger v3',
    status: mergerStatus,
    position: { x: 340, y: mergerY },
    data: {
      mergeResultId: merge?.id,
      clusters: merge?.clusters ?? [],
      mergerVersion: merge?.mergerVersion,
      normalizerVersion: merge?.normalizerVersion,
      ...(usableCount === undefined ? {} : { usableAgentCount: usableCount }),
      ...(expectedCount === undefined ? {} : { expectedAgentCount: expectedCount }),
      unavailableAgentStackIds: merge?.unavailableAgentStackIds ?? [],
    },
  });
  for (const stackId of stacksToRender) {
    edges.push({
      id: 'e-agent-' + stackId + '-merger',
      source: 'agent-' + stackId,
      target: 'merger',
      state:
        merge !== undefined
          ? 'completed'
          : (() => {
              const view = agents.find((a) => a.agentStackId === stackId);
              if (view === undefined) return 'pending' as const;
              return TERMINAL_AGENT.has(view.status) ? edgeStateFor(view.status) : 'active';
            })(),
    });
  }

  const verification = input.verificationRuns?.[0];
  // Honest verifier: no MergeResult → blocked; merge without verification →
  // ready; active VerificationRun → running; terminal → persisted status.
  const verifierStatus =
    verification !== undefined ? verification.status : merge !== undefined ? 'ready' : 'blocked';
  nodes.push({
    id: 'verifier',
    kind: 'verifier',
    label: 'Verifier v3',
    status: verifierStatus,
    position: { x: 340, y: mergerY + 130 },
    data: {
      verificationRunId: verification?.id,
      attempts: verification?.attempts ?? [],
      verifierVersion: verification?.verifierVersion,
      recipeVersion: verification?.recipeVersion,
      signatureVersion: verification?.signatureVersion,
    },
  });
  edges.push({
    id: 'e-merger-verifier',
    source: 'merger',
    target: 'verifier',
    state: merge !== undefined ? 'completed' : 'pending',
  });

  // Honest issues: no MergeResult → waiting; merge without ingest → ready;
  // occurrences exist → completed. Zero-issue ingest still counts as ingest;
  // callers pass ingestRan when the idempotent ingest marker was observed.
  const ingestRan = (input as { ingestRan?: boolean }).ingestRan ?? (input.issueCount ?? 0) > 0;
  const issuesStatus = merge === undefined ? 'waiting' : ingestRan ? 'completed' : 'ready';
  nodes.push({
    id: 'issues',
    kind: 'issues',
    label: 'Issues',
    status: issuesStatus,
    position: { x: 340, y: mergerY + 260 },
    data: {
      count: input.issueCount ?? 0,
      ingestRan,
      findings: input.findings.map((f) => ({ severity: f.severity })),
    },
  });
  edges.push({
    id: 'e-verifier-issues',
    source: 'verifier',
    target: 'issues',
    state: verification !== undefined ? edgeStateFor(verification.status) : 'pending',
  });

  return { nodes, edges, agents };
}

export interface RetestWorkspaceInput extends RunWorkspaceInput {
  readonly sourceRevisionId: string;
  readonly targetRevisionId: string;
  /** Frozen backend field is `result`; `outcome` accepted as legacy alias. */
  readonly assessment?: { result?: string; outcome?: string };
}

export function buildRetestGraph(
  input: RetestWorkspaceInput,
  now?: number,
): { nodes: RunGraphNode[]; edges: RunGraphEdge[]; agents: AgentNodeView[] } {
  const base = buildRunGraph(input, now);
  const sourceNode: RunGraphNode = {
    id: 'retest-source',
    kind: 'retest-source',
    label: 'Revision A (source)',
    status: 'completed',
    position: { x: 40, y: 0 },
    data: { revisionId: input.sourceRevisionId },
  };
  const specNode: RunGraphNode = {
    id: 'retest-spec',
    kind: 'retest-spec',
    label: 'RetestSpec v2',
    status: 'completed',
    position: { x: 40, y: 110 },
    data: { targetRevisionId: input.targetRevisionId },
  };
  const assessmentResult = input.assessment?.result ?? input.assessment?.outcome;
  const assessmentNode: RunGraphNode = {
    id: 'retest-assessment',
    kind: 'retest-assessment',
    label: 'Retest Assessment',
    status: assessmentResult ?? input.run.status,
    position: { x: 340, y: base.nodes[base.nodes.length - 1]?.position.y ?? 900 },
    data: { result: assessmentResult, outcome: assessmentResult },
  };
  return {
    agents: base.agents,
    nodes: [sourceNode, specNode, ...base.nodes, assessmentNode],
    edges: [
      {
        id: 'e-retest-source-spec',
        source: 'retest-source',
        target: 'retest-spec',
        state: 'completed',
      },
      {
        id: 'e-retest-spec-revision',
        source: 'retest-spec',
        target: 'revision',
        state: 'completed',
      },
      ...base.edges,
      {
        id: 'e-issues-assessment',
        source: 'issues',
        target: 'retest-assessment',
        state: edgeStateFor(input.run.status),
      },
    ],
  };
}
