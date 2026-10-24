import React from 'react';
import { CopyId } from './CopyId.js';
import { StatusPill, dotClassForStatus } from './ui/StatusPill.js';
import { AGENT_DISPLAY_NAMES, formatCount } from '../lib/agent-telemetry.js';

export function RunSummaryPanel({
  snapshot,
  onFocusAgent,
}: {
  snapshot: Record<string, unknown>;
  onFocusAgent?: (stackId: string) => void;
}): React.JSX.Element {
  const run = snapshot['run'] as Record<string, unknown>;
  const project = snapshot['project'] as Record<string, unknown> | undefined;
  const revision = snapshot['revision'] as Record<string, unknown> | undefined;
  const agentRuns = (snapshot['agentRuns'] as Array<Record<string, unknown>>) ?? [];
  const findings = (snapshot['findings'] as unknown[]) ?? [];
  const evidence = (snapshot['evidence'] as unknown[]) ?? [];
  // Historical merger/verifier/issues payloads may still be present on old
  // runs; the active product reports independent per-agent results instead.
  void (snapshot['mergeResults'] as unknown);
  void (snapshot['verificationRuns'] as unknown);
  void (snapshot['issues'] as unknown);
  const projectName =
    project !== undefined
      ? String(project['name'] ?? run['projectId'] ?? '')
      : String(run['projectId'] ?? '');
  const countsByAgent = new Map<string, number>();
  for (const finding of findings) {
    if (typeof finding === 'object' && finding !== null) {
      const agentRunId = String((finding as Record<string, unknown>)['agentRunId'] ?? '');
      countsByAgent.set(agentRunId, (countsByAgent.get(agentRunId) ?? 0) + 1);
    }
  }
  const completedAgentCount = agentRuns.filter((agent) => agent['status'] === 'completed').length;
  const configuration = run['configuration'] as { agentStackIds?: string[] } | undefined;
  const selected = [
    ...new Set(
      configuration?.agentStackIds ?? agentRuns.map((agent) => String(agent['agentStackId'])),
    ),
  ];
  const terminal = ['completed', 'partial', 'failed', 'cancelled'].includes(String(run['status']));
  const runningCount = agentRuns.filter((agent) =>
    ['starting', 'planning', 'running'].includes(String(agent['status'])),
  ).length;
  const failedCount = agentRuns.filter((agent) =>
    ['failed', 'timed_out', 'interrupted'].includes(String(agent['status'])),
  ).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section aria-label="Run status">
        <div className="section-title" style={{ marginBottom: 8 }}>
          Run
        </div>
        <StatusPill status={String(run['status'] ?? 'unknown')} />
        <div className="metadata" style={{ marginTop: 6 }}>
          {String(run['mode'] ?? '').toUpperCase() +
            ' QA · ' +
            (run['executionKind'] === 'production' ? 'Production' : 'Legacy simulation')}
        </div>
      </section>
      <section aria-label="Results by agent">
        <div className="section-title" style={{ marginBottom: 8 }}>
          Results
        </div>
        <p className="metadata">{String(selected.length) + ' selected'}</p>
        <p className="metadata">
          {String(runningCount) +
            ' running · ' +
            String(completedAgentCount) +
            ' completed · ' +
            String(failedCount) +
            ' failed / timed out / interrupted'}
        </p>
        {selected.length > 0 ? (
          <div
            className="result-observation"
            role="img"
            aria-label={
              completedAgentCount +
              ' of ' +
              selected.length +
              ' selected agent executions completed'
            }
          >
            <div className="result-observation-count">
              <strong>
                {completedAgentCount} <span>/ {selected.length}</span>
              </strong>
              <small>AGENT EXECUTIONS COMPLETE</small>
            </div>
            <div className="result-observation-track" aria-hidden="true">
              {selected.map((stackId) => (
                <span
                  key={stackId}
                  className={
                    'result-observation-node ' +
                    String(
                      agentRuns.find((agent) => agent['agentStackId'] === stackId)?.['status'] ??
                        '',
                    )
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        {selected.length === 0 ? (
          <p className="metadata">Agent selection was not recorded for this run.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {selected.map((stackId) => {
              const agent = agentRuns.find((item) => item['agentStackId'] === stackId);
              const id = String(agent?.['id'] ?? '');
              const status = String(agent?.['status'] ?? (terminal ? 'Not started' : 'Waiting'));
              const count = countsByAgent.get(id) ?? 0;
              return (
                <button
                  key={stackId}
                  className="agent-row"
                  onClick={() => onFocusAgent?.(stackId)}
                  title="Select this agent on the canvas"
                >
                  <span className={dotClassForStatus(status)} aria-hidden="true" />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className="grow truncate"
                        title={AGENT_DISPLAY_NAMES[stackId] ?? stackId}
                      >
                        {AGENT_DISPLAY_NAMES[stackId] ?? stackId}
                      </span>
                      <span className="metric-chip">
                        {formatCount(count) + (count === 1 ? ' finding' : ' findings')}
                      </span>
                    </span>
                    <span className="metadata" style={{ display: 'block' }}>
                      {status}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="metadata" style={{ marginTop: 8 }}>
          {formatCount(findings.length) +
            ' total ' +
            (findings.length === 1 ? 'finding' : 'findings') +
            ' · ' +
            formatCount(evidence.length) +
            ' evidence'}
        </div>
        {['partial', 'failed', 'cancelled'].includes(String(run['status'])) ? (
          <p className="metadata">
            Incomplete analysis. Reported findings and evidence are retained independently for each
            agent.
          </p>
        ) : null}
      </section>
      <section aria-label="Snapshot details">
        <div className="section-title" style={{ marginBottom: 8 }}>
          Snapshot
        </div>
        <dl className="kv">
          <dt>Project</dt>
          <dd>
            <span className="truncate" title={projectName} style={{ display: 'block' }}>
              {projectName}
            </span>
          </dd>
          <dt>Revision</dt>
          <dd>
            <CopyId id={String(revision?.['id'] ?? run['projectRevisionId'] ?? '')} />
          </dd>
          <dt>Snapshot</dt>
          <dd>
            <CopyId id={String(run['snapshotId'] ?? '')} />
          </dd>
          <dt>Run</dt>
          <dd>
            <CopyId id={String(run['id'] ?? '')} />
          </dd>
        </dl>
      </section>
    </div>
  );
}
