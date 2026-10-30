/**
 * Deterministic run-graph builder: RunWorkspaceView → React Flow nodes/edges.
 * Same run state always produces the same graph. Topology is Sentry-owned;
 * node positions are deterministic auto-layout (top → bottom with a
 * horizontal agent fan-out).
 */
import type { AgentNodeView, AgentRunLike, EvidenceLike, FindingLike, RunLike } from './types.js';
import { projectAgentTelemetry, AGENT_DISPLAY_NAMES } from './agent-telemetry.js';

export type RunNodeKind = 'project' | 'revision' | 'snapshot' | 'target' | 'agent';

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

  // Render the recorded selection, with waiting placeholders before AgentRuns
  // exist. Older runs can fall back to recorded AgentRuns; never invent agents
  // when neither source establishes which stacks were selected.
  const stacksToRender =
    input.run.configuration?.agentStackIds ?? input.agentRuns.map((a) => a.agentStackId);
  const agentY = input.run.mode === 'targeted' ? 470 : 360;
  stacksToRender.forEach((stackId, index) => {
    const view = agents.find((a) => a.agentStackId === stackId);
    const nodeId = 'agent-' + stackId;
    const x = 40 + index * 260;
    nodes.push({
      id: nodeId,
      kind: 'agent',
      label: view?.displayName ?? AGENT_DISPLAY_NAMES[stackId] ?? stackId,
      status:
        view?.status ??
        (['completed', 'partial', 'failed', 'cancelled'].includes(input.run.status)
          ? 'not_started'
          : 'waiting'),
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

  return { nodes, edges, agents };
}
