import React from 'react';
import { CopyId } from './CopyId.js';

export function RunSummaryPanel({
  snapshot,
  onFocusAgent,
}: {
  snapshot: Record<string, unknown>;
  onFocusAgent?: (stackId: string) => void;
}): React.JSX.Element {
  const run = snapshot['run'] as Record<string, unknown>;
  const agentRuns = (snapshot['agentRuns'] as Array<Record<string, unknown>>) ?? [];
  const findings = (snapshot['findings'] as unknown[]) ?? [];
  const evidence = (snapshot['evidence'] as unknown[]) ?? [];
  const mergeResults = (snapshot['mergeResults'] as Array<Record<string, unknown>>) ?? [];
  const verificationRuns = (snapshot['verificationRuns'] as unknown[]) ?? [];
  const issues = (snapshot['issues'] as unknown[]) ?? [];
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Run summary</h3>
      <dl
        style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 }}
      >
        <dt className="faint">Status</dt>
        <dd style={{ margin: 0 }}>{String(run['status'] ?? '')}</dd>
        <dt className="faint">Mode</dt>
        <dd style={{ margin: 0 }}>{String(run['mode'] ?? '')}</dd>
        <dt className="faint">Kind</dt>
        <dd style={{ margin: 0 }}>{String(run['executionKind'] ?? 'simulation')}</dd>
        <dt className="faint">Run</dt>
        <dd style={{ margin: 0 }}>
          <CopyId id={String(run['id'] ?? '')} />
        </dd>
        <dt className="faint">Snapshot</dt>
        <dd style={{ margin: 0 }}>
          <CopyId id={String(run['snapshotId'] ?? '')} />
        </dd>
        <dt className="faint">Started</dt>
        <dd style={{ margin: 0 }} className="mono">
          {String(run['startedAt'] ?? run['createdAt'] ?? '')}
        </dd>
        {run['completedAt'] != null ? (
          <>
            <dt className="faint">Completed</dt>
            <dd style={{ margin: 0 }} className="mono">
              {String(run['completedAt'])}
            </dd>
          </>
        ) : null}
      </dl>
      <h4>Agents</h4>
      <ul style={{ paddingLeft: 18 }}>
        {agentRuns.map((agent) => (
          <li key={String(agent['id'])}>
            <button
              onClick={() => onFocusAgent?.(String(agent['agentStackId']))}
              title="Center this agent on the canvas"
              style={{ padding: '0 6px', fontSize: 11 }}
            >
              ◎
            </button>{' '}
            {String(agent['agentStackId'])} — {String(agent['status'])}
          </li>
        ))}
        {agentRuns.length === 0 ? (
          <li className="muted">No agent runs yet — agents are waiting.</li>
        ) : null}
      </ul>
      <h4>Pipeline</h4>
      <ul style={{ paddingLeft: 18 }}>
        <li>Findings: {findings.length}</li>
        <li>Evidence: {evidence.length}</li>
        <li>Merge results: {mergeResults.length}</li>
        <li>Verification runs: {verificationRuns.length}</li>
        <li>Occurrences: {issues.length}</li>
      </ul>
    </div>
  );
}
