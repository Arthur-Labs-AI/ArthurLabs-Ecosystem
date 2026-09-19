import React from 'react';
import type { AgentNodeView, TimelineItem } from '../lib/types.js';
import {
  formatCount,
  formatElapsed,
  projectTimeline,
  truncateMiddle,
} from '../lib/agent-telemetry.js';
import { CopyId } from './CopyId.js';
import { StatusLabel } from './StatusGlyph.js';

export interface AgentInspectorData {
  readonly view: AgentNodeView;
  readonly events?: readonly {
    type: string;
    agentRunId: string;
    timestamp: string;
    tool?: { name?: string; inputSummary?: string; exitCode?: number; durationMs?: number };
    command?: string;
    exitCode?: number;
    durationMs?: number;
    relativePath?: string;
    operation?: string;
    suite?: string;
    passed?: number;
    failed?: number;
    skipped?: number;
    message?: string;
    status?: string;
    code?: string;
    operationId?: string;
    finding?: { id?: string; title?: string; severity?: string };
    evidence?: { id?: string; type?: string };
    failure?: { code: string; message: string; retryable?: boolean };
  }[];
  readonly findings?: readonly {
    id: string;
    title: string;
    severity: string;
    category?: string;
    description?: string;
  }[];
  readonly evidence?: readonly { id: string; type: string; strength?: string }[];
}

const CATEGORY_ICON: Record<string, string> = {
  Lifecycle: '\u25CF',
  File: '\u2630',
  Command: '\u203A',
  Test: '\u2713',
  Planning: '\u25CB',
  Finding: '!',
  Evidence: '\u25A0',
  Warning: '!',
  Runtime: '\u25CC',
};

export function AgentInspector({ data }: { data: AgentInspectorData }): React.JSX.Element {
  const { view } = data;
  const [selectedEvent, setSelectedEvent] = React.useState<number | undefined>(undefined);
  const timeline: readonly TimelineItem[] = React.useMemo(
    () => projectTimeline((data.events ?? []) as never, []),
    [data.events],
  );
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>{view.displayName} QA</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        <StatusLabel status={view.status} />
      </p>
      <dl
        className="mono"
        style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}
      >
        <dt className="faint">Model</dt>
        <dd style={{ margin: 0 }}>{view.model}</dd>
        <dt className="faint">Agent run</dt>
        <dd style={{ margin: 0 }}>
          <CopyId id={view.agentRunId} />
        </dd>
        <dt className="faint">Elapsed</dt>
        <dd style={{ margin: 0 }}>{formatElapsed(view.elapsedMs)}</dd>
        <dt className="faint">Turns</dt>
        <dd style={{ margin: 0 }}>{view.turns ?? '—'}</dd>
      </dl>
      <h4>Current stage</h4>
      <p>
        <strong>{view.currentStage === 'working' ? 'Working' : view.currentStage}</strong>
        <br />
        <span className="muted">{view.currentOperation.title}</span>
        {view.currentOperation.detail !== undefined ? (
          <span className="mono" style={{ display: 'block' }}>
            {view.currentOperation.detail}
          </span>
        ) : null}
      </p>
      <h4>Stages</h4>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {view.stages.map((stage) => (
          <li key={stage.id}>
            {stage.state === 'completed'
              ? '\u2713'
              : stage.state === 'active'
                ? '\u25CF'
                : stage.state === 'failed'
                  ? '\u00D7'
                  : stage.state === 'cancelled'
                    ? '\u25A0'
                    : stage.state === 'warning'
                      ? '!'
                      : '\u25CB'}{' '}
            {stage.label} — {stage.state}
          </li>
        ))}
      </ul>
      <h4>Timeline</h4>
      {timeline.length === 0 ? (
        <p className="muted">Activity unavailable.</p>
      ) : (
        <div className="timeline">
          {timeline.map((item, index) => (
            <div key={index} className="item">
              <span className="time">{(item.timestamp ?? '').slice(11, 19)}</span>
              <button
                onClick={() => setSelectedEvent(selectedEvent === index ? undefined : index)}
                aria-label={'Inspect event ' + item.title}
                title={item.title}
                style={{ padding: '0 6px', fontSize: 11 }}
              >
                {CATEGORY_ICON[item.category] ?? '\u25CF'}
              </button>
              <span>
                {item.title}
                <span className="faint"> · {item.category}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {selectedEvent !== undefined && data.events?.[selectedEvent] !== undefined ? (
        <EventDetail event={data.events[selectedEvent] as Record<string, unknown>} />
      ) : null}
      <h4>Findings & evidence</h4>
      <p>
        {formatCount(view.findingsCount)} findings · {formatCount(view.evidenceCount)} evidence
      </p>
      {(data.findings ?? []).map((finding) => (
        <div key={finding.id} className="card" style={{ marginBottom: 8 }}>
          <strong>
            [{finding.severity.toUpperCase()}] {finding.title}
          </strong>
          {finding.description !== undefined ? (
            <p className="muted">{truncateMiddle(finding.description, 240)}</p>
          ) : null}
          <CopyId id={finding.id} />
        </div>
      ))}
      {Object.keys(view.severityCounts).length > 0 ? (
        <p className="mono muted">
          {Object.entries(view.severityCounts)
            .map(([severity, count]) => severity + ': ' + String(count))
            .join(' · ')}
        </p>
      ) : null}
      <h4>Telemetry</h4>
      <p className="mono">
        Operations {formatCount(view.telemetry.operations)} · Files{' '}
        {formatCount(view.telemetry.filesInspected)} · Commands{' '}
        {formatCount(view.telemetry.commands)} · Tests {formatCount(view.telemetry.tests)}
      </p>
      <h4>Tokens</h4>
      <p className="mono">
        Input {view.inputTokens !== undefined ? formatCount(view.inputTokens) : '—'} · Output{' '}
        {view.outputTokens !== undefined ? formatCount(view.outputTokens) : '—'} · Cached{' '}
        {view.cachedInputTokens !== undefined ? formatCount(view.cachedInputTokens) : '—'} · Total{' '}
        {view.totalTokens !== undefined ? formatCount(view.totalTokens) : '—'}
      </p>
      {view.status === 'failed' && view.failure !== undefined ? (
        <div className="error-box">
          <strong>
            {view.failure.code}: {truncateMiddle(view.failure.message, 300)}
          </strong>
          <p className="muted">Retryable: {view.failure.retryable === true ? 'yes' : 'no'}</p>
        </div>
      ) : view.status === 'failed' ? (
        <div className="error-box">
          <strong>Agent failed.</strong> Structured failure unavailable — see timeline.
        </div>
      ) : null}
      {view.status === 'cancelled' ? (
        <div className="card">
          <strong>■ Cancelled by user.</strong>
          <p className="muted">
            Completed before cancellation: {formatCount(view.findingsCount)} findings ·{' '}
            {formatCount(view.evidenceCount)} evidence.
          </p>
        </div>
      ) : null}
      {view.status === 'timed_out' ? (
        <div className="card">
          <strong>TIMED OUT</strong>
          <p className="muted">Distinct from failure: the agent exceeded its time budget.</p>
        </div>
      ) : null}
      {view.status === 'interrupted' ? (
        <div className="card">
          <strong>INTERRUPTED</strong>
          <p className="muted">Sentry stopped before completion.</p>
        </div>
      ) : null}
    </div>
  );
}

function EventDetail({ event }: { event: Record<string, unknown> }): React.JSX.Element {
  const type = String(event['type'] ?? 'event');
  const rows: Array<[string, string]> = [];
  const push = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    rows.push([label, truncateMiddle(String(value), 500)]);
  };
  push('Type', type);
  push('Timestamp', event['timestamp']);
  push('Operation', event['operationId']);
  const tool = event['tool'] as Record<string, unknown> | undefined;
  if (tool !== undefined) {
    push('Tool', tool['name']);
    push('Input', tool['inputSummary']);
    push('Exit', tool['exitCode']);
    push('Duration ms', tool['durationMs']);
  }
  push('Command', event['command']);
  push('Exit', event['exitCode']);
  push('Duration ms', event['durationMs']);
  push('File', event['relativePath']);
  push('File operation', event['operation']);
  push('Suite', event['suite']);
  push('Passed', event['passed']);
  push('Failed', event['failed']);
  push('Skipped', event['skipped']);
  push('Status', event['status']);
  push('Message', event['message']);
  push('Code', event['code']);
  const finding = event['finding'] as Record<string, unknown> | undefined;
  if (finding !== undefined) {
    push('Finding', finding['title']);
    push('Severity', finding['severity']);
  }
  const evidence = event['evidence'] as Record<string, unknown> | undefined;
  if (evidence !== undefined) {
    push('Evidence', evidence['id']);
    push('Evidence type', evidence['type']);
  }
  const failure = event['failure'] as Record<string, unknown> | undefined;
  if (failure !== undefined) {
    push('Failure code', failure['code']);
    push('Failure message', failure['message']);
  }
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <h4 style={{ marginTop: 0 }}>Operation detail</h4>
      <dl
        className="mono"
        style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}
      >
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="faint">{label}</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <details>
        <summary className="muted">Raw event</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {JSON.stringify(event, null, 2).slice(0, 4000)}
        </pre>
      </details>
    </div>
  );
}
