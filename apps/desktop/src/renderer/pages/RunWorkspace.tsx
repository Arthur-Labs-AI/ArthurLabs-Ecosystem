import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { RunCanvas } from '../components/RunCanvas.js';
import { AgentInspector } from '../components/AgentInspector.js';
import { RunSummaryPanel } from '../components/RunSummaryPanel.js';
import { CopyId } from '../components/CopyId.js';
import { StatusPill } from '../components/ui/StatusPill.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';
import { ToastStack, type ToastItem } from '../components/ui/Toast.js';
import { EdgeInspector, NodeStatusHeader } from '../components/PipelineInspectors.js';
import { AGENT_DISPLAY_NAMES } from '../lib/agent-telemetry.js';
import { buildRunGraph } from '../lib/run-graph.js';
import { useRunSnapshot } from '../lib/use-live-run.js';
import { useDeveloperMode } from '../lib/developer-mode.js';
import { sentryApi } from '../lib/sentry-api.js';

const LEFT_KEY = 'sentry:run-layout:left-width';
const RIGHT_KEY = 'sentry:run-layout:right-width';
const LEFT_DEFAULT = 280;
const RIGHT_DEFAULT = 400;

function loadWidth(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function formatClock(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startIso: string | undefined, endIso: string | null | undefined): string {
  if (startIso === undefined || startIso === '') return '—';
  const start = new Date(startIso).getTime();
  const end = endIso != null && endIso !== '' ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
  return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
}

let toastId = 0;

export function RunWorkspace(): React.JSX.Element {
  const { runId } = useParams();
  const queryClient = useQueryClient();
  const developerMode = useDeveloperMode();
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined);
  const [centerRequest, setCenterRequest] = React.useState<{ id: string; key: number } | undefined>(
    undefined,
  );
  const [collapseLeft, setCollapseLeft] = React.useState(false);
  const [collapseRight, setCollapseRight] = React.useState(false);
  const [leftWidth, setLeftWidth] = React.useState(() => loadWidth(LEFT_KEY, LEFT_DEFAULT));
  const [rightWidth, setRightWidth] = React.useState(() => loadWidth(RIGHT_KEY, RIGHT_DEFAULT));
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const snapshot = useRunSnapshot(runId, 500);

  const dismissToast = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const pushToast = React.useCallback(
    (toast: Omit<ToastItem, 'id'>, autoDismissMs?: number) => {
      toastId += 1;
      const id = toastId;
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      if (autoDismissMs !== undefined) {
        window.setTimeout(() => dismissToast(id), autoDismissMs);
      }
    },
    [dismissToast],
  );

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
  const fail = (e: unknown): void =>
    pushToast({
      tone: 'danger',
      title: 'Action failed',
      body: e instanceof Error ? e.message : String(e),
    });
  const cancel = useMutation({
    mutationFn: () => sentryApi().runs.cancel(runId as string),
    onSuccess: () => {
      setConfirmCancel(false);
      refresh();
    },
    onError: fail,
  });
  const exportSave = useMutation({
    mutationFn: (format: 'log' | 'json') => sentryApi().runs.exportSave(runId as string, format),
    onSuccess: (result, format) => {
      // Save As cancellation is a normal outcome: silent, no error, no file.
      if (result.status === 'cancelled') return;
      const label = format === 'json' ? 'JSON' : 'Log';
      pushToast(
        {
          tone: 'success',
          title: label + ' exported',
          body: result.path,
          action: (
            <button className="compact" onClick={() => revealExport.mutate(result.path)}>
              Show in folder
            </button>
          ),
        },
        9000,
      );
      refresh();
    },
    onError: fail,
  });
  const revealExport = useMutation({
    mutationFn: (path: string) => sentryApi().runs.revealExport(path),
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
          projectRevisionId?: string;
          createdAt: string;
          startedAt?: string;
          completedAt?: string | null;
          configuration?: { agentStackIds?: string[] };
        };
        project?: { name?: string };
        revision?: { id?: string };
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
          sourceAgentStackId?: string;
          severity: string;
          title: string;
          confidence?: string;
          category?: string;
          categoryDetail?: string;
          description?: string;
          expectedBehavior?: string;
          actualBehavior?: string;
          rootCause?: string;
          recommendedFix?: string;
          reproductionSteps?: string[];
          locations?: Array<{
            relativePath: string;
            startLine?: number;
            endLine?: number;
            symbol?: string;
            message?: string;
          }>;
          evidenceIds?: string[];
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
        // Historical merger/verifier/issues payloads may still arrive from
        // older runs via runs:get; the active product ignores them.
      }
    | undefined;

  const projectName = useQuery({
    queryKey: ['project-name', data?.run.projectId],
    queryFn: () => sentryApi().projects.get(data?.run.projectId as string),
    enabled: data?.run.projectId !== undefined,
  });
  const resolvedProjectName =
    (projectName.data as { name?: string } | undefined)?.name ??
    data?.project?.name ??
    data?.run.projectId ??
    '';

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
      },
      Date.now(),
    );
  }, [data]);

  const resizeState = React.useRef({ left: leftWidth, right: rightWidth });
  resizeState.current = { left: leftWidth, right: rightWidth };
  const startResize = React.useCallback((side: 'left' | 'right', event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = resizeState.current[side];
    const onMove = (move: PointerEvent): void => {
      const delta = move.clientX - startX;
      if (side === 'left') {
        setLeftWidth(clamp(Math.round(startWidth + delta), 220, 400));
      } else {
        setRightWidth(clamp(Math.round(startWidth - delta), 300, 600));
      }
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        window.localStorage.setItem(LEFT_KEY, String(resizeState.current.left));
        window.localStorage.setItem(RIGHT_KEY, String(resizeState.current.right));
      } catch {
        /* presentation-only */
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  if (snapshot.isLoading) return <div className="skeleton">Loading run…</div>;
  if (data === undefined) {
    return (
      <div className="error-box" role="alert">
        Could not load run {runId}. Check runtime connectivity before starting another run.
      </div>
    );
  }

  const terminal = ['completed', 'partial', 'failed', 'cancelled'].includes(data.run.status);
  const isActive = !terminal;
  const selectedNode = graph?.nodes.find((n) => n.id === selectedId);
  const selectedAgent = graph?.agents.find((a) => 'agent-' + a.agentStackId === selectedId);
  const selectedEdge = graph?.edges.find((e) => e.id === selectedId);
  const cancelState = (cancel.data as { status?: string } | undefined)?.status;
  const focusAgent = (stackId: string): void => {
    const id = 'agent-' + stackId;
    setSelectedId(id);
    setCenterRequest((prev) => ({ id, key: (prev?.key ?? 0) + 1 }));
    if (collapseRight) setCollapseRight(false);
  };

  return (
    <div className="run-page">
      {snapshot.isError || snapshot.runtimeUnavailable ? (
        <div className="inline-notice tone-warning" role="status">
          {
            'Run refresh unavailable. Cached results remain available; the last recorded status below may have changed. Check'
          }{' '}
          <Link to="/settings/runtime">Runtime settings</Link>
          {'.'}
          {'This communication error does not mean the QA run failed.'}
        </div>
      ) : null}
      <nav className="metadata" aria-label="Breadcrumb">
        <Link to="/projects">Projects</Link> /{' '}
        <Link to={'/projects/' + data.run.projectId}>{resolvedProjectName}</Link> /{'QA Run'}
      </nav>
      <header className="card run-header" aria-label="Run header">
        <div className="run-header-row">
          <div className="title-block">
            <h1 className="page-title">{data.run.mode.toUpperCase() + ' QA'}</h1>
            <StatusPill status={data.run.status} pulse={isActive} />
            {data.run.executionKind === 'production' ? null : (
              <span
                className="badge legacy"
                title="Historical development run — Sentry no longer creates simulation runs"
              >
                Legacy simulation
              </span>
            )}
          </div>
          <div className="run-actions">
            {terminal ? (
              <>
                <button
                  className="compact"
                  onClick={() => exportSave.mutate('json')}
                  disabled={exportSave.isPending}
                >
                  Export JSON
                </button>
                <button
                  className="compact"
                  onClick={() => exportSave.mutate('log')}
                  disabled={exportSave.isPending}
                >
                  Export Log
                </button>
                <Link to={'/projects/' + data.run.projectId}>
                  <button className="ghost compact">Open Project</button>
                </Link>
              </>
            ) : null}
            {isActive ? (
              confirmCancel ? (
                <span className="metadata">
                  Cancel? Findings are preserved.{' '}
                  <button className="compact ghost" onClick={() => setConfirmCancel(false)}>
                    Keep running
                  </button>{' '}
                  <button
                    className="compact danger"
                    onClick={() => cancel.mutate()}
                    disabled={cancel.isPending}
                  >
                    Cancel run
                  </button>
                </span>
              ) : (
                <button className="compact danger" onClick={() => setConfirmCancel(true)}>
                  Cancel run
                </button>
              )
            ) : null}
          </div>
        </div>
        <div className="run-meta-row">
          <span title={'Started ' + String(data.run.startedAt ?? data.run.createdAt)}>
            {'Started ' + formatClock(data.run.startedAt ?? data.run.createdAt)}
          </span>
          <span>
            {'Duration ' +
              formatDuration(data.run.startedAt ?? data.run.createdAt, data.run.completedAt)}
          </span>
          <span>
            {String(data.run.configuration?.agentStackIds?.length ?? data.agentRuns.length) +
              ' selected agents'}
          </span>
          <span>
            {String(data.findings.length) +
              (data.findings.length === 1 ? ' finding' : ' findings') +
              ' · ' +
              String(data.evidence.length) +
              ' evidence'}
          </span>
          {cancelState !== undefined ? <span>{'Cancellation: ' + cancelState}</span> : null}
        </div>
        <CollapsibleSection title="Details">
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Project</dt>
            <dd>
              <Link to={'/projects/' + data.run.projectId}>{resolvedProjectName}</Link>
            </dd>
            <dt>Run ID</dt>
            <dd>
              <CopyId id={data.run.id} short={22} />
            </dd>
            <dt>Snapshot</dt>
            <dd>
              <CopyId id={data.run.snapshotId} short={22} />
            </dd>
            {data.run.projectRevisionId !== undefined ? (
              <>
                <dt>Revision</dt>
                <dd>
                  <CopyId id={data.run.projectRevisionId} short={22} />
                </dd>
              </>
            ) : null}
            <dt>Started</dt>
            <dd className="mono">{String(data.run.startedAt ?? data.run.createdAt)}</dd>
            {data.run.completedAt != null ? (
              <>
                <dt>Completed</dt>
                <dd className="mono">{String(data.run.completedAt)}</dd>
              </>
            ) : null}
          </dl>
        </CollapsibleSection>
      </header>
      {['failed', 'partial', 'cancelled'].includes(data.run.status) ? (
        <div className="inline-notice tone-warning" role="status">
          <strong>{'Analysis ' + data.run.status + '.'}</strong>{' '}
          <span>Reported findings and evidence are retained independently for each agent.</span>
          {data.agentRuns
            .filter((agent) => ['failed', 'timed_out', 'interrupted'].includes(agent.status))
            .map((agent) => (
              <p key={agent.id}>
                {AGENT_DISPLAY_NAMES[agent.agentStackId] ?? agent.agentStackId}:{' '}
                {agent.status.replaceAll('_', ' ')}.
                {agent.failure !== undefined
                  ? ' ' + agent.failure.code + ': ' + agent.failure.message
                  : ' Structured failure details were not recorded.'}
              </p>
            ))}
          {data.agentRuns.length === 0 ? <span> No agent execution was recorded.</span> : null}{' '}
          <span>
            Review agent details and Environment before deliberately starting another run.
          </span>
        </div>
      ) : null}
      {!terminal ? <div className="inline-notice">Export unlocks at terminal status.</div> : null}
      {graph === undefined ? (
        <div className="skeleton">Building execution graph…</div>
      ) : (
        <div className="workspace" role="region" aria-label="Run workspace">
          {collapseLeft ? (
            <div className="ws-rail">
              <button
                className="icon-btn ghost"
                onClick={() => setCollapseLeft(false)}
                aria-label="Expand overview panel"
                title="Expand overview panel"
              >
                <ChevronsRight size={15} />
              </button>
            </div>
          ) : (
            <div className="ws-panel" style={{ width: leftWidth }} aria-label="Run overview">
              <div className="panel-head">
                Overview
                <button
                  className="icon-btn ghost"
                  onClick={() => setCollapseLeft(true)}
                  aria-label="Collapse overview panel"
                  title="Collapse overview panel"
                  style={{ marginLeft: 'auto' }}
                >
                  <ChevronsLeft size={14} />
                </button>
              </div>
              <div className="panel-body">
                <RunSummaryPanel
                  snapshot={data as unknown as Record<string, unknown>}
                  onFocusAgent={focusAgent}
                />
              </div>
            </div>
          )}
          <div
            className="ws-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize overview panel"
            onPointerDown={(e) => startResize('left', e)}
          />
          <div className="ws-center">
            <RunCanvas
              runId={data.run.id}
              nodes={graph.nodes}
              edges={graph.edges}
              selectedId={selectedId}
              centerRequest={centerRequest}
              onSelect={setSelectedId}
              onSelectEdge={setSelectedId}
            />
          </div>
          <div
            className="ws-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector panel"
            onPointerDown={(e) => startResize('right', e)}
          />
          {collapseRight ? (
            <div className="ws-rail">
              <button
                className="icon-btn ghost"
                onClick={() => setCollapseRight(false)}
                aria-label="Expand inspector panel"
                title="Expand inspector panel"
              >
                <ChevronsLeft size={15} />
              </button>
            </div>
          ) : (
            <div className="ws-panel" style={{ width: rightWidth }} aria-label="Inspector">
              <div className="panel-head">
                Details
                <button
                  className="icon-btn ghost"
                  onClick={() => setCollapseRight(true)}
                  aria-label="Collapse inspector panel"
                  title="Collapse inspector panel"
                  style={{ marginLeft: 'auto' }}
                >
                  <ChevronsRight size={14} />
                </button>
              </div>
              <div className="panel-body">
                {selectedAgent !== undefined ? (
                  <AgentInspector
                    key={selectedAgent.agentRunId}
                    data={{
                      view: selectedAgent,
                      events: (data.events.filter(
                        (e) => e.agentRunId === selectedAgent.agentRunId,
                      ) ?? []) as never,
                      findings: data.findings.filter(
                        (f) => f.agentRunId === selectedAgent.agentRunId,
                      ),
                      evidence: data.evidence.filter(
                        (e) => e.agentRunId === selectedAgent.agentRunId,
                      ),
                    }}
                  />
                ) : selectedNode !== undefined ? (
                  <SelectedNodeInspector
                    nodeId={selectedNode.id}
                    label={selectedNode.label}
                    status={selectedNode.status}
                    payload={selectedNode.data}
                    developerMode={developerMode}
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
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPanelWidth(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}

function SelectedNodeInspector({
  nodeId,
  label,
  status,
  payload,
  developerMode,
}: {
  nodeId: string;
  label: string;
  status: string;
  payload: Record<string, unknown>;
  developerMode: boolean;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <NodeStatusHeader label={label} status={status} />
      <div>
        <CopyId id={nodeId} short={22} />
      </div>
      {developerMode ? (
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {JSON.stringify(payload, null, 2).slice(0, 4000)}
        </pre>
      ) : (
        <p className="metadata" style={{ margin: 0 }}>
          Raw payload JSON is available in developer mode (Settings → Application).
        </p>
      )}
    </div>
  );
}
