import React from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  Bug,
  Cpu,
  Eye,
  FileText,
  Fingerprint,
  FlaskConical,
  MessageSquare,
  Terminal,
} from 'lucide-react';
import type { AgentNodeView, TimelineItem } from '../lib/types.js';
import {
  formatCount,
  formatElapsed,
  projectTimeline,
  stageLabel,
  stageStateLabel,
  truncateMiddle,
} from '../lib/agent-telemetry.js';
import { CopyId } from './CopyId.js';
import { StatusIcon } from './StatusGlyph.js';
import { StatusPill } from './ui/StatusPill.js';
import { Tabs } from './ui/Tabs.js';
import { useDeveloperMode } from '../lib/developer-mode.js';

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
  readonly findings?: readonly InspectorFinding[];
  readonly evidence?: readonly InspectorEvidence[];
}

export interface InspectorFinding {
  readonly id: string;
  readonly agentRunId?: string;
  readonly sourceAgentStackId?: string;
  readonly title: string;
  readonly severity: string;
  readonly confidence?: string;
  readonly category?: string;
  readonly categoryDetail?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly actualBehavior?: string;
  readonly rootCause?: string;
  readonly recommendedFix?: string;
  readonly reproductionSteps?: readonly string[];
  readonly locations?: readonly {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    symbol?: string;
    message?: string;
  }[];
  readonly evidenceIds?: readonly string[];
}

export interface InspectorEvidence {
  readonly id: string;
  readonly type: string;
  readonly strength?: string;
}

const CATEGORY_ICON: Record<string, React.ComponentType<{ size?: number | string }>> = {
  Message: MessageSquare,
  Lifecycle: Activity,
  File: FileText,
  Command: Terminal,
  Test: FlaskConical,
  Planning: Brain,
  Finding: Bug,
  Evidence: Fingerprint,
  Warning: AlertTriangle,
  Runtime: Cpu,
};

function categoryIcon(category: string): React.JSX.Element {
  const Icon = CATEGORY_ICON[category] ?? Activity;
  return <Icon size={13} />;
}

const ACTIVITY_FILTERS = ['All', 'Files', 'Commands', 'Tests', 'Findings', 'Warnings'] as const;

function activityMatches(item: TimelineItem, filter: (typeof ACTIVITY_FILTERS)[number]): boolean {
  switch (filter) {
    case 'All':
      return true;
    case 'Files':
      return item.category === 'File';
    case 'Commands':
      return item.category === 'Command';
    case 'Tests':
      return item.category === 'Test';
    case 'Findings':
      return item.category === 'Finding' || item.category === 'Evidence';
    case 'Warnings':
      return item.category === 'Warning';
  }
}

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'] as const;

export function AgentInspector({
  data,
  initialTab,
}: {
  data: AgentInspectorData;
  initialTab?: string;
}): React.JSX.Element {
  const { view } = data;
  const developerMode = useDeveloperMode();
  const findings = data.findings ?? [];
  const evidence = data.evidence ?? [];
  const tabs = React.useMemo(() => {
    const list = [
      { id: 'overview', label: 'Overview' },
      {
        id: 'findings',
        label: 'Findings' + (findings.length > 0 ? ' (' + findings.length + ')' : ''),
      },
      { id: 'activity', label: 'Activity' },
      {
        id: 'evidence',
        label: 'Evidence' + (evidence.length > 0 ? ' (' + evidence.length + ')' : ''),
      },
    ];
    if (developerMode) list.push({ id: 'diagnostics', label: 'Diagnostics' });
    return list;
  }, [findings.length, evidence.length, developerMode]);
  const [tab, setTab] = React.useState(initialTab ?? 'overview');
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'overview';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div>
        <h3 className="card-title" style={{ fontSize: 15 }}>
          {view.displayName} QA
        </h3>
        <div style={{ marginTop: 6 }}>
          <StatusPill status={view.status} />
        </div>
      </div>
      <Tabs tabs={tabs} active={activeTab} onChange={setTab} label="Agent details" />
      <div style={{ minHeight: 0 }}>
        {activeTab === 'overview' ? <OverviewTab view={view} /> : null}
        {activeTab === 'findings' ? (
          <FindingsTab findings={findings} evidence={evidence} status={view.status} />
        ) : null}
        {activeTab === 'activity' ? (
          <ActivityTab events={data.events ?? []} developerMode={developerMode} />
        ) : null}
        {activeTab === 'evidence' ? <EvidenceTab evidence={evidence} findings={findings} /> : null}
        {activeTab === 'diagnostics' && developerMode ? (
          <DiagnosticsTab view={view} events={data.events ?? []} />
        ) : null}
      </div>
    </div>
  );
}

function OverviewTab({ view }: { view: AgentNodeView }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <dl className="kv">
        <dt>Model</dt>
        <dd className="mono truncate" title={view.model}>
          {view.model}
        </dd>
        <dt>Agent run</dt>
        <dd>
          <CopyId id={view.agentRunId} />
        </dd>
        <dt>Elapsed</dt>
        <dd>{formatElapsed(view.elapsedMs)}</dd>
        <dt>Stage</dt>
        <dd>{view.currentStage === 'working' ? 'Working' : stageLabel(view.currentStage)}</dd>
      </dl>
      <div>
        <div className="metadata">Current operation</div>
        <div className="wrap-anywhere">{view.currentOperation.title}</div>
        {view.currentOperation.detail !== undefined ? (
          <div className="mono wrap-anywhere metadata" title={view.currentOperation.detail}>
            {view.currentOperation.detail}
          </div>
        ) : null}
      </div>
      <div>
        <div className="metadata" style={{ marginBottom: 4 }}>
          Stages
        </div>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {view.stages.map((stage) => (
            <li key={stage.id} className="metadata">
              <span className="stage-icon" aria-hidden="true">
                {stage.state === 'observed' ? (
                  <Eye size={12} />
                ) : (
                  <StatusIcon status={stage.state} size={12} />
                )}
              </span>{' '}
              {stage.label}
              {' — '}
              {stageStateLabel(stage.state)}
            </li>
          ))}
        </ul>
      </div>
      <div className="metric-grid">
        <div className="metric-card">
          <div className="metric-value">
            {view.turns === undefined ? '—' : formatCount(view.turns)}
          </div>
          <div className="metric-label">Turns</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">
            {view.totalTokens === undefined ? '—' : formatCount(view.totalTokens)}
          </div>
          <div className="metric-label">Tokens</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{formatCount(view.telemetry.filesInspected)}</div>
          <div className="metric-label">Files</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{formatCount(view.telemetry.commands)}</div>
          <div className="metric-label">Commands</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{formatCount(view.telemetry.tests)}</div>
          <div className="metric-label">Tests</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{formatCount(view.findingsCount)}</div>
          <div className="metric-label">Findings</div>
        </div>
      </div>
      {view.inputTokens !== undefined || view.outputTokens !== undefined ? (
        <p className="mono metadata" style={{ margin: 0 }}>
          {'Input ' +
            (view.inputTokens !== undefined ? formatCount(view.inputTokens) : '\u2014') +
            ' · Output ' +
            (view.outputTokens !== undefined ? formatCount(view.outputTokens) : '\u2014') +
            ' · Cached ' +
            (view.cachedInputTokens !== undefined ? formatCount(view.cachedInputTokens) : '\u2014')}
        </p>
      ) : null}
      {Object.keys(view.severityCounts).length > 0 ? (
        <p className="mono metadata" style={{ margin: 0 }}>
          {Object.entries(view.severityCounts)
            .map(([severity, count]) => severity + ': ' + String(count))
            .join(' · ')}
        </p>
      ) : null}
      {view.failure !== undefined && view.failure !== null ? (
        <div className="error-box">
          <strong>
            {view.failure.code}: {truncateMiddle(view.failure.message, 300)}
          </strong>
          <p className="muted">
            Reported findings and evidence remain available. Check provider settings and Environment
            before deliberately starting another run.
          </p>
        </div>
      ) : view.status === 'failed' ? (
        <div className="error-box">
          <strong>Agent failed.</strong> Structured failure unavailable — see Activity.
        </div>
      ) : null}
      {view.status === 'cancelled' ? (
        <div className="inline-notice">
          <strong>
            <StatusIcon status="cancelled" size={13} /> Cancelled.
          </strong>
          <span className="muted">
            {' '}
            Retained before cancellation: {formatCount(view.findingsCount)} findings ·{' '}
            {formatCount(view.evidenceCount)} evidence.
          </span>
        </div>
      ) : null}
      {view.status === 'timed_out' ? (
        <div className="inline-notice tone-warning">
          <strong>Timed out.</strong>{' '}
          <span className="muted">Distinct from failure: the agent exceeded its time budget.</span>
        </div>
      ) : null}
      {view.status === 'interrupted' ? (
        <div className="inline-notice">
          <strong>Interrupted.</strong>{' '}
          <span className="muted">Sentry stopped before completion.</span>
        </div>
      ) : null}
    </div>
  );
}

function FindingsTab({
  findings,
  evidence,
  status,
}: {
  findings: readonly InspectorFinding[];
  evidence: readonly InspectorEvidence[];
  status: string;
}): React.JSX.Element {
  const [severity, setSeverity] = React.useState<string>('All');
  const available = React.useMemo(
    () => new Set(findings.map((f) => f.severity.toLowerCase())),
    [findings],
  );
  const showFilter = findings.length > 1;
  const visible =
    severity === 'All'
      ? findings
      : findings.filter((f) => f.severity.toLowerCase() === severity.toLowerCase());
  if (findings.length === 0) {
    return (
      <p className="muted">
        {status === 'completed'
          ? 'Completed with no reported findings.'
          : ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(status)
            ? 'No findings were reported before ' +
              status.replaceAll('_', ' ') +
              '. Analysis is incomplete.'
            : 'No findings reported by this agent yet.'}
        {evidence.length > 0 ? ' Evidence is available in the Evidence tab.' : ''}
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {['failed', 'cancelled', 'timed_out', 'interrupted'].includes(status) ? (
        <p className="inline-notice">
          {'Partial report — agent ' +
            status.replaceAll('_', ' ') +
            '. Reported findings and evidence are retained; analysis is incomplete.'}
        </p>
      ) : null}
      {showFilter ? (
        <div className="filter-row" role="group" aria-label="Filter findings by severity">
          {['All' as const, ...SEVERITIES.filter((s) => available.has(s.toLowerCase()))].map(
            (option) => (
              <button
                key={option}
                className="compact"
                aria-pressed={severity === option}
                onClick={() => setSeverity(option)}
                style={
                  severity === option
                    ? { borderColor: 'var(--accent)', background: 'var(--bg-panel)' }
                    : undefined
                }
              >
                {option}
              </button>
            ),
          )}
        </div>
      ) : null}
      {visible.map((finding) => (
        <FindingCard key={finding.id} finding={finding} evidence={evidence} />
      ))}
      {visible.length === 0 ? (
        <p className="muted">No {severity.toLowerCase()} findings from this agent.</p>
      ) : null}
    </div>
  );
}

type InspectorEvent = NonNullable<AgentInspectorData['events']>[number];

function ActivityTab({
  events,
  developerMode,
}: {
  events: readonly InspectorEvent[];
  developerMode: boolean;
}): React.JSX.Element {
  const [filter, setFilter] = React.useState<(typeof ACTIVITY_FILTERS)[number]>('All');
  const [selectedEvent, setSelectedEvent] = React.useState<number | undefined>(undefined);
  const timeline: readonly TimelineItem[] = React.useMemo(
    () => projectTimeline((events ?? []) as never, []),
    [events],
  );
  const visible = timeline
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => activityMatches(item, filter));
  React.useEffect(() => {
    setSelectedEvent(undefined);
  }, [filter]);
  if (timeline.length === 0) {
    return <p className="muted">Activity unavailable.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="filter-row" role="group" aria-label="Filter activity by category">
        {ACTIVITY_FILTERS.map((option) => (
          <button
            key={option}
            className="compact"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            style={
              filter === option
                ? { borderColor: 'var(--accent)', background: 'var(--bg-panel)' }
                : undefined
            }
          >
            {option}
          </button>
        ))}
      </div>
      <div className="timeline">
        {visible.map(({ item, index }) => (
          <div key={index} className="item">
            <span className="time">{(item.timestamp ?? '').slice(11, 19)}</span>
            <button
              className="icon-btn ghost compact"
              onClick={() => setSelectedEvent(selectedEvent === index ? undefined : index)}
              aria-label={'Inspect event ' + item.title}
              aria-expanded={selectedEvent === index}
              title={item.title}
            >
              {categoryIcon(item.category)}
            </button>
            <button
              className="ghost event-row"
              onClick={() => setSelectedEvent(selectedEvent === index ? undefined : index)}
              aria-expanded={selectedEvent === index}
            >
              <span className="wrap-anywhere" title={item.title}>
                {item.title}
                <span className="faint"> · {item.category}</span>
              </span>
            </button>
          </div>
        ))}
      </div>
      {visible.length === 0 ? <p className="muted">No {filter.toLowerCase()} activity.</p> : null}
      {selectedEvent !== undefined && events?.[selectedEvent] !== undefined ? (
        <EventDetail
          event={events[selectedEvent] as Record<string, unknown>}
          showRaw={developerMode}
        />
      ) : null}
    </div>
  );
}

function EvidenceTab({
  evidence,
  findings,
}: {
  evidence: readonly InspectorEvidence[];
  findings: readonly InspectorFinding[];
}): React.JSX.Element {
  if (evidence.length === 0) {
    return <p className="muted">No evidence records captured by this agent yet.</p>;
  }
  const linkedFinding = (id: string): InspectorFinding | undefined =>
    findings.find((f) => f.evidenceIds?.includes(id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {evidence.map((item) => {
        const finding = linkedFinding(item.id);
        return (
          <div key={item.id} className="finding-card">
            <div className="chip-row">
              <span className="badge">{item.type}</span>
              {item.strength !== undefined ? <span className="badge">{item.strength}</span> : null}
            </div>
            {finding !== undefined ? (
              <div className="finding-title truncate" title={finding.title}>
                Linked: {finding.title}
              </div>
            ) : null}
            <div>
              <CopyId id={item.id} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DiagnosticsTab({
  view,
  events,
}: {
  view: AgentNodeView;
  events: readonly Record<string, unknown>[];
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="metadata" style={{ margin: 0 }}>
        Developer diagnostics. Hidden unless developer mode is enabled in Settings.
      </p>
      <dl className="kv">
        <dt>Agent run</dt>
        <dd>
          <CopyId id={view.agentRunId} />
        </dd>
        <dt>Stack</dt>
        <dd className="mono">{view.agentStackId}</dd>
        <dt>Status</dt>
        <dd className="mono">{view.status}</dd>
      </dl>
      <details>
        <summary className="muted">Agent view JSON</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {JSON.stringify(view, null, 2).slice(0, 6000)}
        </pre>
      </details>
      <details>
        <summary className="muted">{'Raw events (' + events.length + ')'}</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {JSON.stringify(events, null, 2).slice(0, 8000)}
        </pre>
      </details>
    </div>
  );
}

const FINDING_PREVIEW_CHARS = 200;

function formatLocation(location: NonNullable<InspectorFinding['locations']>[number]): string {
  const range =
    location.startLine !== undefined
      ? ':' +
        String(location.startLine) +
        (location.endLine !== undefined && location.endLine !== location.startLine
          ? '\u2013' + String(location.endLine)
          : '')
      : '';
  const symbol = location.symbol !== undefined ? ' ' + location.symbol : '';
  return location.relativePath + range + symbol;
}

export function FindingCard({
  finding,
  evidence,
}: {
  finding: InspectorFinding;
  evidence: readonly InspectorEvidence[];
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const category =
    finding.category !== undefined ? finding.category.toUpperCase() : 'UNCATEGORIZED';
  const preview =
    finding.description !== undefined && finding.description.length > FINDING_PREVIEW_CHARS
      ? finding.description.slice(0, FINDING_PREVIEW_CHARS) + '\u2026'
      : finding.description;
  const linkedCount = finding.evidenceIds?.length ?? 0;
  const locationCount = finding.locations?.length ?? 0;
  return (
    <div className="finding-card">
      <div className="chip-row" aria-label={finding.severity.toUpperCase() + ' · ' + category}>
        <span className="badge" aria-hidden="true">
          {finding.severity.toUpperCase()}
        </span>
        <span className="badge" aria-hidden="true">
          {category}
        </span>
      </div>
      <div className="finding-title">{finding.title}</div>
      {preview !== undefined ? <div className="body-secondary">{preview}</div> : null}
      <div className="metadata">
        {locationCount > 0
          ? locationCount + ' location' + (locationCount === 1 ? '' : 's') + ' · '
          : ''}
        {linkedCount} evidence
      </div>
      {finding.locations !== undefined && finding.locations.length > 0 ? (
        <div
          className="mono faint truncate"
          style={{ fontSize: 11 }}
          title={formatLocation(
            finding.locations[0] as NonNullable<InspectorFinding['locations']>[number],
          )}
        >
          {formatLocation(
            finding.locations[0] as NonNullable<InspectorFinding['locations']>[number],
          )}
          {finding.locations.length > 1
            ? ' (+' + String(finding.locations.length - 1) + ' more)'
            : ''}
        </div>
      ) : null}
      <div>
        <button className="compact" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? 'Hide details' : 'View details'}
        </button>{' '}
        <CopyId id={finding.id} />
      </div>
      {expanded ? <FindingDetail finding={finding} evidence={evidence} /> : null}
    </div>
  );
}

export function FindingDetail({
  finding,
  evidence,
}: {
  finding: InspectorFinding;
  evidence: readonly InspectorEvidence[];
}): React.JSX.Element {
  const missing = <span className="muted">Not provided by this agent.</span>;
  const section = (label: string, body: React.ReactNode): React.JSX.Element => (
    <div style={{ marginTop: 8 }}>
      <p className="faint" style={{ margin: '0 0 2px', fontSize: 11 }}>
        {label}
      </p>
      <div>{body}</div>
    </div>
  );
  const pre = (text: string): React.JSX.Element => (
    <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{text}</p>
  );
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border-default)', paddingTop: 8 }}>
      <h4 style={{ margin: '0 0 4px' }}>{finding.title}</h4>
      {section(
        'Severity',
        <span style={{ textTransform: 'uppercase' }}>{finding.severity.toLowerCase()}</span>,
      )}
      {section(
        'Confidence',
        finding.confidence !== undefined ? (
          <span>{finding.confidence.toUpperCase()}</span>
        ) : (
          missing
        ),
      )}
      {section(
        'Category',
        finding.category !== undefined ? (
          <span>
            {finding.category}
            {finding.categoryDetail !== undefined ? ' — ' + finding.categoryDetail : ''}
          </span>
        ) : (
          missing
        ),
      )}
      {finding.sourceAgentStackId !== undefined
        ? section('Agent', <CopyId id={finding.sourceAgentStackId} />)
        : null}
      {section(
        'Description',
        finding.description !== undefined ? pre(finding.description) : missing,
      )}
      {section(
        'Expected behavior',
        finding.expectedBehavior !== undefined ? pre(finding.expectedBehavior) : missing,
      )}
      {section(
        'Actual behavior',
        finding.actualBehavior !== undefined ? pre(finding.actualBehavior) : missing,
      )}
      {section('Root cause', finding.rootCause !== undefined ? pre(finding.rootCause) : missing)}
      {section(
        'Reproduction steps',
        finding.reproductionSteps !== undefined && finding.reproductionSteps.length > 0 ? (
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {finding.reproductionSteps.map((step, index) => (
              <li key={index} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {step}
              </li>
            ))}
          </ol>
        ) : (
          missing
        ),
      )}
      {section(
        'Recommended fix',
        finding.recommendedFix !== undefined ? pre(finding.recommendedFix) : missing,
      )}
      {section(
        'Locations',
        finding.locations !== undefined && finding.locations.length > 0 ? (
          <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
            {finding.locations.map((location, index) => (
              <li key={index} style={{ overflowWrap: 'anywhere' }}>
                {formatLocation(location)}
                {location.message !== undefined ? ' — ' + location.message : ''}
              </li>
            ))}
          </ul>
        ) : (
          missing
        ),
      )}
      {section(
        'Evidence',
        finding.evidenceIds !== undefined && finding.evidenceIds.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {finding.evidenceIds.map((id) => {
              const record = evidenceById.get(id);
              return (
                <li key={id}>
                  <CopyId id={id} />{' '}
                  <span className="muted">
                    {record !== undefined
                      ? record.type + (record.strength !== undefined ? ' · ' + record.strength : '')
                      : 'linked by this agent; record not in this snapshot'}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          missing
        ),
      )}
    </div>
  );
}

function EventDetail({
  event,
  showRaw,
}: {
  event: Record<string, unknown>;
  showRaw: boolean;
}): React.JSX.Element {
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
      <h4 className="card-title">Operation detail</h4>
      <dl className="mono kv" style={{ marginTop: 8 }}>
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="faint">{label}</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {showRaw ? (
        <details>
          <summary className="muted">Raw event</summary>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {JSON.stringify(event, null, 2).slice(0, 4000)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
