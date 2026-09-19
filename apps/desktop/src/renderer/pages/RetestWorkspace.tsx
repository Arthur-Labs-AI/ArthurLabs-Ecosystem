import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RunCanvas } from '../components/RunCanvas.js';
import { buildRetestGraph } from '../lib/run-graph.js';
import { useRetestSnapshot } from '../lib/use-live-run.js';
import { sentryApi } from '../lib/sentry-api.js';
import { CopyId } from '../components/CopyId.js';
import { StatusLabel } from '../components/StatusGlyph.js';

function cancellationNote(cancelled: boolean): string {
  return cancelled ? ' — preserved after cancellation' : '';
}

function outcomeLabel(outcome?: string): string {
  switch (outcome) {
    case 'fixed':
      return '\u2713 FIXED';
    case 'still_reproducible':
      return '\u00D7 STILL REPRODUCIBLE';
    case 'partially_fixed':
      return '\u25D0 PARTIALLY FIXED';
    case 'inconclusive':
      return '? INCONCLUSIVE';
    default:
      return outcome ?? 'pending';
  }
}

export function RetestWorkspace(): React.JSX.Element {
  const { retestRunId } = useParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
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
        targetRun?: {
          id: string;
          projectId: string;
          mode: string;
          status: string;
          snapshotId: string;
          createdAt: string;
          configuration?: { agentStackIds?: string[] };
          agentRuns?: [];
        } & Record<string, unknown>;
        assessments: Array<{ outcome?: string }>;
      }
    | undefined;
  const graph = React.useMemo(() => {
    if (data?.targetRun === undefined) return undefined;
    const targetRun = data.targetRun as unknown as {
      id: string;
      projectId: string;
      mode: string;
      status: string;
      snapshotId: string;
      createdAt: string;
      agentRuns?: Array<{ id: string; qaRunId: string; agentStackId: string; status: string }>;
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
    };
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
        id: targetRun.id,
        projectId: targetRun.projectId,
        mode: targetRun.mode,
        status: targetRun.status,
        snapshotId: targetRun.snapshotId,
        createdAt: targetRun.createdAt,
      },
      agentRuns: (targetRun.agentRuns ?? []) as never,
      findings: targetRun.findings ?? [],
      evidence: targetRun.evidence ?? [],
      eventsByAgent: eventsByAgent as never,
      activitiesByAgent: activitiesByAgent as never,
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
        outcome?: string;
        rationale?: string;
        newEvidenceIds?: string[];
        limitations?: string[];
      }
    | undefined;
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
  const outcome = assessment?.result ?? assessment?.outcome;
  const cancelled = data.retestRun.status === 'cancelled';
  const isActive = !['completed', 'partial', 'failed', 'cancelled'].includes(data.retestRun.status);
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
        <h2 style={{ marginTop: 0 }}>{outcomeLabel(outcome)}</h2>
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
        <div style={{ height: 'calc(100vh - 340px)', minHeight: 420 }}>
          <RunCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      )}
    </div>
  );
}
