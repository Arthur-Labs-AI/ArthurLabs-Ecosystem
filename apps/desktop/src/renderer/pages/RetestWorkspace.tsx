import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RunCanvas } from '../components/RunCanvas.js';
import { AgentInspector } from '../components/AgentInspector.js';
import {
  EdgeInspector,
  IssuesInspector,
  MergerInspector,
  NodeStatusHeader,
  VerifierInspector,
} from '../components/PipelineInspectors.js';
import { buildRetestGraph } from '../lib/run-graph.js';
import { useRetestSnapshot } from '../lib/use-live-run.js';
import { sentryApi } from '../lib/sentry-api.js';
import { CopyId } from '../components/CopyId.js';
import { StatusLabel } from '../components/StatusGlyph.js';

function cancellationNote(cancelled: boolean): string {
  return cancelled ? ' — preserved after cancellation' : '';
}

function resultLabel(result?: string): string {
  switch (result) {
    case 'fixed':
      return 'FIXED';
    case 'still_reproducible':
      return 'STILL REPRODUCIBLE';
    case 'partially_fixed':
      return 'PARTIALLY FIXED';
    case 'inconclusive':
      return 'INCONCLUSIVE';
    default:
      return result ?? 'pending';
  }
}

export function RetestWorkspace(): React.JSX.Element {
  const { retestRunId } = useParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  const [collapseRight, setCollapseRight] = React.useState(false);
  const snapshot = useRetestSnapshot(retestRunId, 500);
  const cancel = useMutation({
    mutationFn: () => sentryApi().retests.cancel(retestRunId as string),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['retest', retestRunId] }),
  });
  const data = snapshot.data as
    | {
        retestRun: {
          id: string;
          status: string;
          sourceProjectRevisionId: string;
          targetProjectRevisionId: string;
          targetQaRunId?: string;
        };
        spec?: { targetSnapshotId?: string };
        // Typed DTO: nested DesktopRunSnapshot — renderer reads .run.id.
        targetRun?: {
          run: {
            id: string;
            projectId: string;
            mode: string;
            status: string;
            snapshotId: string;
            createdAt: string;
            configuration?: { agentStackIds?: string[] };
          };
          agentRuns?: Array<{
            id: string;
            qaRunId: string;
            agentStackId: string;
            status: string;
          }>;
          findings?: Array<{ id: string; agentRunId: string; severity: string; title: string }>;
          evidence?: Array<{ id: string; agentRunId: string; type: string }>;
          activities?: Array<{
            id: string;
            agentRunId?: string;
            kind: string;
            status: string;
            title: string;
          }>;
          events?: Array<{ type: string; agentRunId: string; timestamp: string }>;
          mergeResults?: Array<{ id: string }>;
          verificationRuns?: Array<{ id: string; status: string }>;
          issues?: unknown[];
          targetSpec?: { includePaths?: string[]; userInstructions?: string };
        } & Record<string, unknown>;
        assessments: Array<{ result?: string; outcome?: string }>;
      }
    | undefined;
  const graph = React.useMemo(() => {
    if (data?.targetRun === undefined) return undefined;
    const targetRun = data.targetRun;
    const eventsByAgent: Record<string, NonNullable<typeof targetRun.events>> = {};
    for (const event of targetRun.events ?? [])
      (eventsByAgent[event.agentRunId] ??= []).push(event);
    const activitiesByAgent: Record<string, NonNullable<typeof targetRun.activities>> = {};
    for (const activity of targetRun.activities ?? []) {
      if (activity.agentRunId === undefined) continue;
      (activitiesByAgent[activity.agentRunId] ??= []).push(activity);
    }
    return buildRetestGraph({
      run: {
        id: targetRun.run.id,
        projectId: targetRun.run.projectId,
        mode: targetRun.run.mode,
        status: targetRun.run.status,
        snapshotId: targetRun.run.snapshotId,
        createdAt: targetRun.run.createdAt,
      },
      agentRuns: (targetRun.agentRuns ?? []) as never,
      findings: targetRun.findings ?? [],
      evidence: targetRun.evidence ?? [],
      eventsByAgent: eventsByAgent as never,
      activitiesByAgent: activitiesByAgent as never,
      ...(targetRun.targetSpec === undefined ? {} : { targetSpec: targetRun.targetSpec }),
      ...(targetRun.mergeResults === undefined
        ? {}
        : { mergeResults: targetRun.mergeResults as never }),
      ...(targetRun.verificationRuns === undefined
        ? {}
        : { verificationRuns: targetRun.verificationRuns as never }),
      issueCount: targetRun.issues?.length ?? 0,
      sourceRevisionId: data.retestRun.sourceProjectRevisionId,
      targetRevisionId: data.retestRun.targetProjectRevisionId,
      ...(data.assessments[0] === undefined ? {} : { assessment: data.assessments[0] }),
    });
  }, [data]);

  if (snapshot.isLoading) return <div className="skeleton">Loading retest…</div>;
  if (snapshot.isError || data === undefined) {
    return (
      <div className="error-box" role="alert">
        Could not load retest {retestRunId}.
      </div>
    );
  }
  const assessment = data.assessments[0] as
    | {
        result?: string;
        rationale?: string;
        newEvidenceIds?: string[];
        limitations?: string[];
      }
    | undefined;
  // Frozen backend field is `result`; the canvas node uses the same value.
  const spec = data.spec as
    | {
        sourceSnapshotId?: string;
        targetSnapshotId?: string;
        historicalPaths?: string[];
        resolvedTargetPaths?: string[];
        resolutionStrategy?: string;
        inputDigest?: string;
        agentStackIds?: string[];
      }
    | undefined;
  const result = assessment?.result;
  const cancelled = data.retestRun.status === 'cancelled';
  const isActive = !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(
    data.retestRun.status,
  );
  const selectedNode = graph?.nodes.find((n) => n.id === selectedId);
  const selectedAgent = graph?.agents.find((a) => 'agent-' + a.agentStackId === selectedId);
  const selectedEdge = graph?.edges.find((e) => e.id === selectedId);
  const targetEvents = (data.targetRun?.events ?? []) as Array<Record<string, unknown>>;
  const targetFindings = (data.targetRun?.findings ?? []) as Array<Record<string, unknown>>;
  const targetEvidence = (data.targetRun?.evidence ?? []) as Array<Record<string, unknown>>;
  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/issues">Issues</Link> / Retest <CopyId id={data.retestRun.id} />
      </p>
      <h1 style={{ margin: '4px 0' }}>
        Retest <StatusLabel status={data.retestRun.status} />
      </h1>
      <p className="mono muted">
        REVISION A <CopyId id={data.retestRun.sourceProjectRevisionId} /> → REVISION B{' '}
        <CopyId id={data.retestRun.targetProjectRevisionId} />
      </p>
      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>{resultLabel(result)}</h2>
        <p className="muted">
          Retest assessment comes from the deterministic backend only — never inferred by the UI.
        </p>
        {assessment?.rationale !== undefined ? <p>{assessment.rationale}</p> : null}
        {(assessment?.newEvidenceIds ?? []).length > 0 ? (
          <p className="muted">Evidence: {(assessment?.newEvidenceIds ?? []).length} item(s)</p>
        ) : null}
        {(assessment?.limitations ?? []).length > 0 ? (
          <p className="muted">Limitations: {(assessment?.limitations ?? []).join('; ')}</p>
        ) : null}
        {isActive ? (
          <button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel Retest
          </button>
        ) : null}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>RetestSpec v2 (preserved{cancellationNote(cancelled)})</h3>
        {spec === undefined ? (
          <p className="muted">Spec materializes at the target freeze.</p>
        ) : (
          <>
            <p className="mono muted">
              Source snapshot <CopyId id={spec.sourceSnapshotId ?? ''} /> → Target snapshot{' '}
              <CopyId id={spec.targetSnapshotId ?? ''} />
            </p>
            <p className="muted">
              Strategy: {spec.resolutionStrategy ?? '—'} · Digest:{' '}
              <span className="mono">{(spec.inputDigest ?? '').slice(0, 20)}</span>
            </p>
            <p className="muted">
              Historical: {(spec.historicalPaths ?? []).join(', ') || '—'} → Resolved:{' '}
              {(spec.resolvedTargetPaths ?? []).join(', ') || '—'}
            </p>
            <p className="muted">Agents: {(spec.agentStackIds ?? []).join(', ')}</p>
          </>
        )}
        <p className="mono muted">Target run: {data.retestRun.targetQaRunId ?? '—'}</p>
      </div>
      {graph === undefined ? (
        <div className="empty">
          Target run has not materialized yet — the source revision and spec are preserved above.
        </div>
      ) : (
        <div className="workspace" style={{ height: 'calc(100vh - 340px)', minHeight: 420 }}>
          <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
            <RunCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onSelectEdge={setSelectedId}
            />
          </div>
          <div className="panel">
            <button onClick={() => setCollapseRight((v) => !v)} aria-label="Toggle inspector">
              {collapseRight ? '<<' : '>>'}
            </button>
            {collapseRight ? null : selectedAgent !== undefined ? (
              <AgentInspector
                data={{
                  view: selectedAgent,
                  events: targetEvents.filter(
                    (e) => (e['agentRunId'] as string) === selectedAgent.agentRunId,
                  ) as never,
                  findings: targetFindings.filter(
                    (f) => (f['agentRunId'] as string) === selectedAgent.agentRunId,
                  ) as never,
                  evidence: targetEvidence.filter(
                    (e) => (e['agentRunId'] as string) === selectedAgent.agentRunId,
                  ) as never,
                }}
              />
            ) : selectedNode !== undefined ? (
              <RetestNodeInspector
                nodeId={selectedNode.id}
                label={selectedNode.label}
                status={selectedNode.status}
                payload={selectedNode.data}
              />
            ) : selectedEdge !== undefined ? (
              <EdgeInspector edge={selectedEdge} />
            ) : (
              <p className="muted">Select an agent or assessment node.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RetestNodeInspector({
  nodeId,
  label,
  status,
  payload,
}: {
  nodeId: string;
  label: string;
  status: string;
  payload: Record<string, unknown>;
}): React.JSX.Element {
  if (nodeId === 'merger') return <MergerInspector payload={payload} />;
  if (nodeId === 'verifier') return <VerifierInspector payload={payload} />;
  if (nodeId === 'issues') return <IssuesInspector payload={payload} occurrences={[]} />;
  return (
    <div>
      <NodeStatusHeader label={label} status={status} />
      <p className="mono faint">{nodeId}</p>
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
        {JSON.stringify(payload, null, 2).slice(0, 4000)}
      </pre>
    </div>
  );
}
