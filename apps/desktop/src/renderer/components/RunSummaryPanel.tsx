import React from 'react';
import { CopyId } from './CopyId.js';
import { AGENT_DISPLAY_NAMES } from '../lib/agent-telemetry.js';

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
        <dt className="faint">Execution</dt>
        <dd style={{ margin: 0 }}>
          {run['executionKind'] === 'production'
            ? 'Production'
            : 'Legacy simulation (historical — no new simulation runs can be created)'}
        </dd>
        <dt className="faint">Project</dt>
        <dd style={{ margin: 0 }}>
          {project !== undefined
            ? String(project['name'] ?? run['projectId'] ?? '')
            : String(run['projectId'] ?? '')}{' '}
          <CopyId id={String(run['projectId'] ?? '')} />
        </dd>
        <dt className="faint">Revision</dt>
        <dd style={{ margin: 0 }}>
          <CopyId id={String(revision?.['id'] ?? run['projectRevisionId'] ?? '')} />
          <span className="faint"> immutable imported revision</span>
        </dd>
        <dt className="faint">Run</dt>
        <dd style={{ margin: 0 }}>
          <CopyId id={String(run['id'] ?? '')} />
        </dd>
        <dt className="faint">Snapshot</dt>
        <dd style={{ margin: 0 }}>
          <CopyId id={String(run['snapshotId'] ?? '')} />
          <span className="faint"> frozen</span>
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
      <h4>Independent agent results</h4>
      <ul style={{ paddingLeft: 18 }}>
        {agentRuns.map((agent) => {
          const stackId = String(agent['agentStackId']);
          const id = String(agent['id']);
          const count = findings.filter(
            (finding) =>
              typeof finding === 'object' &&
              finding !== null &&
              (finding as Record<string, unknown>)['agentRunId'] === id,
          ).length;
          return (
            <li key={id}>
              {AGENT_DISPLAY_NAMES[stackId] ?? stackId} — {count} finding
              {count === 1 ? '' : 's'}
            </li>
          );
        })}
        {agentRuns.length === 0 ? (
          <li className="muted">No agent runs yet — agents are waiting.</li>
        ) : null}
      </ul>
      <p className="muted">
        {findings.length} total finding{findings.length === 1 ? '' : 's'} across {agentRuns.length}{' '}
        independent agent{agentRuns.length === 1 ? '' : 's'} · {evidence.length} evidence record
        {evidence.length === 1 ? '' : 's'}
      </p>
    </div>
  );
}
