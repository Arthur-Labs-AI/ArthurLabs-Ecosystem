import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RunCanvas } from '../components/RunCanvas.js';
import { AgentInspector } from '../components/AgentInspector.js';
import { RunSummaryPanel } from '../components/RunSummaryPanel.js';
import { StatusLabel } from '../components/StatusGlyph.js';
import { CopyId } from '../components/CopyId.js';
import {
  EdgeInspector,
  IssuesInspector,
  MergerInspector,
  NodeStatusHeader,
  VerifierInspector,
} from '../components/PipelineInspectors.js';
import { buildRunGraph } from '../lib/run-graph.js';
import { useRunSnapshot } from '../lib/use-live-run.js';
import { sentryApi } from '../lib/sentry-api.js';

export function RunWorkspace(): React.JSX.Element {
  const { runId } = useParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  const [collapseLeft, setCollapseLeft] = React.useState(false);
  const [collapseRight, setCollapseRight] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | undefined>(undefined);
  const [actionNote, setActionNote] = React.useState<string | undefined>(undefined);
  const snapshot = useRunSnapshot(runId, 500);

  React.useEffect(() => {
    const onEscape = (): void => {
      setSelectedId(undefined);
      setConfirmCancel(false);
    };
    window.addEventListener('sentry:escape', onEscape);
    return () => window.removeEventListener('sentry:escape', onEscape);
  }, []);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['run', runId] });
  };
  const fail = (e: unknown): void => setActionError(e instanceof Error ? e.message : String(e));
  const cancel = useMutation({
    mutationFn: () => sentryApi().runs.cancel(runId as string),
    onSuccess: () => {
      setConfirmCancel(false);
      refresh();
    },
    onError: fail,
  });
  const merge = useMutation({
    mutationFn: () => sentryApi().runs.merge(runId as string),
    onSuccess: (result) => {
      const info = result as { result?: { clusters?: unknown[] }; reused?: boolean };
      const clusters = Array.isArray(info.result?.clusters)
        ? info.result?.clusters?.length
        : undefined;
      setActionNote(
        clusters !== undefined
          ? 'Merge complete: ' +
              String(clusters) +
              ' cluster(s) produced' +
              (info.reused === true ? ' (reused)' : '')
          : 'Merge complete',
      );
      refresh();
    },
    onError: fail,
  });
  const readMergeId = (): string | undefined => {
    const snap = queryClient.getQueryData(['run', runId]) as
      | {
          currentMergeResultId?: string;
          mergeResults?: Array<{ id: string }>;
        }
      | undefined;
    // Authoritative current MergeResult (highest supported mergerVersion)
    // from the runtime DTO — never repository ordering ([0]).
    if (snap?.currentMergeResultId !== undefined) return snap.currentMergeResultId;
    return snap?.mergeResults?.[0]?.id;
  };
  const ingest = useMutation({
    mutationFn: async () => {
      const id = readMergeId();
      if (id === undefined) throw new Error('Merge first: no MergeResult yet');
      return sentryApi().runs.ingest(id);
    },
    onSuccess: (result) => {
      const info = result as { issues?: unknown[] };
      setActionNote(
        Array.isArray(info.issues)
          ? 'Issues ingested: ' + String(info.issues.length) + ' issue occurrence(s) created'
          : 'Issues ingested',
      );
      refresh();
    },
    onError: fail,
  });
  const verify = useMutation({
    mutationFn: async () => {
      const id = readMergeId();
      if (id === undefined) throw new Error('Merge first: no MergeResult yet');
      return sentryApi().runs.verify(id);
    },
    onSuccess: (result) => {
      const info = result as { attempts?: Array<{ outcome?: string }> };
      if (Array.isArray(info.attempts)) {
        const reproduced = info.attempts.filter((a) => a.outcome === 'reproduced').length;
        const inconclusive = info.attempts.filter((a) => a.outcome === 'inconclusive').length;
        setActionNote(
          'Verification complete: ' +
            String(reproduced) +
            ' reproduced, ' +
            String(inconclusive) +
            ' inconclusive. Ingesting issues…',
        );
      } else {
        setActionNote('Verification complete. Ingesting issues…');
      }
      refresh();
      // Close the gap: verified clusters become tracked issues without a
      // second click. Ingest is idempotent, so the manual button below
      // stays a safe fallback.
      ingest.mutate();
    },
    onError: fail,
  });
  const exportRun = useMutation({
    mutationFn: (format: 'log' | 'json') => sentryApi().runs.exportRun(runId as string, format),
    onSuccess: (result) => {
      const info = result as { path?: string; exportId?: string };
      setActionNote(info.path !== undefined ? 'Export ready: ' + info.path : 'Export ready');
      void result;
      refresh();
    },
    onError: fail,
  });

  const data = snapshot.data as
    | {
        run: {
          id: string;
          projectId: string;
          mode: string;
          status: string;
          executionKind?: string;
          snapshotId: string;
          createdAt: string;
          startedAt?: string;
          completedAt?: string | null;
          configuration?: { agentStackIds?: string[] };
        };
        agentRuns: Array<{
          id: string;
          qaRunId: string;
          agentStackId: string;
          status: string;
          startedAt?: string;
          completedAt?: string | null;
          runtimeIdentity?: { modelId?: string };
          usage?: {
            turns?: number;
            inputTokens?: number;
            outputTokens?: number;
            cachedInputTokens?: number;
          };
          failure?: { code: string; message: string; retryable?: boolean };
        }>;
        findings: Array<{
          id: string;
          agentRunId: string;
          severity: string;
          title: string;
          category?: string;
          description?: string;
        }>;
        evidence: Array<{ id: string; agentRunId: string; type: string; strength?: string }>;
        activities: Array<{
          id: string;
          agentRunId?: string;
          kind: string;
          status: string;
          title: string;
          startedAt?: string;
        }>;
        events: Array<
          Record<string, unknown> & { type: string; agentRunId: string; timestamp: string }
        >;
        targetSpec?: { includePaths?: string[]; userInstructions?: string };
        mergeResults?: Array<{ id: string; clusters?: Array<{ id: string }> }>;
        verificationRuns?: Array<{
          id: string;
          status: string;
          attempts?: Array<{ outcome?: string }>;
        }>;
        issues?: unknown[];
      }
    | undefined;

  const graph = React.useMemo(() => {
    if (data === undefined) return undefined;
    const eventsByAgent: Record<string, typeof data.events> = {};
    for (const event of data.events) {
      (eventsByAgent[event.agentRunId] ??= []).push(event);
    }
    const activitiesByAgent: Record<string, typeof data.activities> = {};
    for (const activity of data.activities) {
      if (activity.agentRunId === undefined) continue;
      (activitiesByAgent[activity.agentRunId] ??= []).push(activity);
    }
    return buildRunGraph(
      {
        run: data.run,
        agentRuns: data.agentRuns,
        findings: data.findings,
        evidence: data.evidence,
        eventsByAgent: eventsByAgent as never,
        activitiesByAgent: activitiesByAgent as never,
        ...(data.targetSpec === undefined ? {} : { targetSpec: data.targetSpec }),
        ...(data.mergeResults === undefined ? {} : { mergeResults: data.mergeResults }),
        ...(data.verificationRuns === undefined ? {} : { verificationRuns: data.verificationRuns }),
        issueCount: data.issues?.length ?? 0,
      },
      Date.now(),
    );
  }, [data]);

  if (snapshot.isLoading) return <div className="skeleton">Loading run…</div>;
  if (snapshot.isError || data === undefined) {
    return (
      <div className="error-box" role="alert">
        Could not load run {runId}. {(snapshot.error as Error | undefined)?.message ?? ''}
      </div>
    );
  }

  const terminal = ['completed', 'partial', 'failed', 'cancelled'].includes(data.run.status);
  const isActive = !terminal;
  const selectedNode = graph?.nodes.find((n) => n.id === selectedId);
  const selectedAgent = graph?.agents.find((a) => 'agent-' + a.agentStackId === selectedId);
  const selectedEdge = graph?.edges.find((e) => e.id === selectedId);
  const cancelState = (cancel.data as { status?: string } | undefined)?.status;
  const focusAgent = (stackId: string): void => setSelectedId('agent-' + stackId);

  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/runs">Runs</Link> / <CopyId id={data.run.id} />
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: '4px 0' }}>
          {data.run.mode.toUpperCase()} QA <StatusLabel status={data.run.status} />
        </h1>
        {data.run.executionKind === 'production' ? null : (
          <span
            className="badge legacy"
            title="Historical development run — Sentry no longer creates simulation runs"
          >
            LEGACY SIMULATION
          </span>
        )}
        {isActive ? (
          confirmCancel ? (
            <span>
              Cancel this run? Completed findings and evidence will be preserved.{' '}
              <button onClick={() => setConfirmCancel(false)}>Keep Running</button>{' '}
              <button
                className="danger"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                Cancel Run
              </button>
            </span>
          ) : (
            <button className="danger" onClick={() => setConfirmCancel(true)}>
              Cancel Run
            </button>
          )
        ) : null}
      </div>
      <p className="muted mono">
        Revision · Snapshot <CopyId id={data.run.snapshotId} /> · Started{' '}
        {data.run.startedAt ?? data.run.createdAt} · {data.agentRuns.length} agents
        {cancelState !== undefined ? ' · Cancellation: ' + cancelState : null}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {terminal ? (
          <>
            <button onClick={() => merge.mutate()} disabled={merge.isPending}>
              Merge
            </button>
            <button onClick={() => verify.mutate()} disabled={verify.isPending}>
              Verify
            </button>
            <button onClick={() => ingest.mutate()} disabled={ingest.isPending}>
              Ingest Issues
            </button>
            <button onClick={() => exportRun.mutate('json')} disabled={exportRun.isPending}>
              Export JSON
            </button>
            <button onClick={() => exportRun.mutate('log')} disabled={exportRun.isPending}>
              Export Log
            </button>
            <Link to={'/projects/' + data.run.projectId}>Open Project</Link>
          </>
        ) : (
          <span className="muted">
            Merge, Verify, Ingest, and Export unlock at terminal status.
          </span>
        )}
      </div>
      {data.run.status === 'failed' ? (
        <div className="error-box" role="alert">
          <strong>Run failed.</strong>{' '}
          {(
            data.agentRuns as Array<{
              status?: string;
              failure?: { code?: string; message?: string };
            }>
          )
            .filter(
              (a) =>
                a.status === 'failed' || a.status === 'timed_out' || a.status === 'interrupted',
            )
            .map((a, i) => (
              <span key={i}>
                {a.failure?.code ?? 'AGENT_FAILED'}:{' '}
                {a.failure?.message ?? 'agent did not complete'}.{' '}
              </span>
            ))}
          {data.agentRuns.length === 0 ? (
            <span>
              No agents started — the failure happened before execution (e.g. locked project,
              changed working copy, or invalid target). Check the project state and retry.
            </span>
          ) : null}
        </div>
      ) : null}
      {actionError !== undefined ? (
        <div className="error-box" role="alert">
          {actionError} <button onClick={() => setActionError(undefined)}>Dismiss</button>
        </div>
      ) : null}
      {actionNote !== undefined ? (
        <div className="card" style={{ marginBottom: 12 }}>
          {actionNote} <button onClick={() => setActionNote(undefined)}>Dismiss</button>
        </div>
      ) : null}
      {graph === undefined ? (
        <div className="skeleton">Building execution graph…</div>
      ) : (
        <div
          className={
            'workspace' +
            (collapseLeft ? ' collapse-left' : '') +
            (collapseRight ? ' collapse-right' : '')
          }
        >
          <div className="panel">
            <button onClick={() => setCollapseLeft((v) => !v)} aria-label="Toggle run summary">
              {collapseLeft ? '»' : '«'}
            </button>
            {collapseLeft ? null : (
              <RunSummaryPanel
                snapshot={data as unknown as Record<string, unknown>}
                onFocusAgent={focusAgent}
              />
            )}
          </div>
          <RunCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSelectEdge={setSelectedId}
          />
          <div className="panel">
            <button onClick={() => setCollapseRight((v) => !v)} aria-label="Toggle inspector">
              {collapseRight ? '«' : '»'}
            </button>
            {collapseRight ? null : selectedAgent !== undefined ? (
              <AgentInspector
                data={{
                  view: selectedAgent,
                  events: (data.events.filter((e) => e.agentRunId === selectedAgent.agentRunId) ??
                    []) as never,
                  findings: data.findings.filter((f) => f.agentRunId === selectedAgent.agentRunId),
                  evidence: data.evidence.filter((e) => e.agentRunId === selectedAgent.agentRunId),
                }}
              />
            ) : selectedNode !== undefined ? (
              <SelectedNodeInspector
                nodeId={selectedNode.id}
                label={selectedNode.label}
                status={selectedNode.status}
                payload={selectedNode.data}
                occurrences={data.issues ?? []}
              />
            ) : selectedEdge !== undefined ? (
              <EdgeInspector edge={selectedEdge} />
            ) : (
              <p className="muted">Select a node to inspect it. Esc closes the inspector.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectedNodeInspector({
  nodeId,
  label,
  status,
  payload,
  occurrences,
}: {
  nodeId: string;
  label: string;
  status: string;
  payload: Record<string, unknown>;
  occurrences: unknown[];
}): React.JSX.Element {
  if (nodeId === 'merger') return <MergerInspector payload={payload} />;
  if (nodeId === 'verifier') return <VerifierInspector payload={payload} />;
  if (nodeId === 'issues') return <IssuesInspector payload={payload} occurrences={occurrences} />;
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
