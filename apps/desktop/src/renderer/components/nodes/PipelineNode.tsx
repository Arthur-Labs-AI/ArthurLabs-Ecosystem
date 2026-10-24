import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { summarizeVerificationAttempts, severityBreakdown } from '../../lib/verify-summary.js';
import { StatusIcon, nodeStateClass } from '../StatusGlyph.js';
import { dotClassForStatus } from '../ui/StatusPill.js';
import { truncateMiddle } from '../../lib/agent-telemetry.js';

export function PipelineNode({ data }: NodeProps): React.JSX.Element {
  const label = (data['label'] as string) ?? 'Node';
  const status = (data['status'] as string) ?? 'pending';
  const kind = (data['kind'] as string) ?? '';
  const payload = (data['payload'] as Record<string, unknown>) ?? {};
  return (
    <div
      className={
        'flow-node sys-node ' +
        nodeStateClass(status) +
        ((data['selected'] as boolean) ? ' selected' : '')
      }
      aria-label={label + ' ' + status}
    >
      <Handle type="target" position={Position.Top} />
      <div className="sys-kind">{kind === '' ? 'STEP' : kind.toUpperCase().replace(/-/g, ' ')}</div>
      <div className="node-title" style={{ fontSize: 12 }}>
        <span className={dotClassForStatus(status)} aria-hidden="true" />
        <span className="truncate" title={label}>
          {label}
        </span>
        <span className="faint" aria-hidden="true">
          <StatusIcon status={status} size={12} />
        </span>
      </div>
      {kind === 'merger' ? <MergerSummary payload={payload} /> : null}
      {kind === 'verifier' ? <VerifierSummary payload={payload} /> : null}
      {kind === 'issues' ? <IssuesSummary payload={payload} /> : null}
      {kind === 'target' ? <TargetSummary payload={payload} /> : null}
      {kind === 'retest-assessment' ? <AssessmentSummary payload={payload} /> : null}
      {kind === 'project' || kind === 'revision' || kind === 'snapshot' ? (
        <SystemIdSummary payload={payload} kind={kind} />
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function MergerSummary({ payload }: { payload: Record<string, unknown> }): React.JSX.Element {
  const clusters = (payload['clusters'] as Array<{ id: string }> | undefined) ?? [];
  const usable = payload['usableAgentCount'] as number | undefined;
  const expected = payload['expectedAgentCount'] as number | undefined;
  const unavailable = (payload['unavailableAgentStackIds'] as string[] | undefined) ?? [];
  return (
    <div className="node-sub" style={{ marginTop: 4 }}>
      Merger · {clusters.length} cluster{clusters.length === 1 ? '' : 's'}
      {usable !== undefined && expected !== undefined ? (
        <div>
          Agents usable {usable}/{expected}
        </div>
      ) : null}
      {unavailable.length > 0 ? (
        <div className="truncate" title={'Unavailable: ' + unavailable.join(', ')}>
          Unavailable: {unavailable.join(', ')}
        </div>
      ) : null}
    </div>
  );
}

function VerifierSummary({ payload }: { payload: Record<string, unknown> }): React.JSX.Element {
  const attempts = (payload['attempts'] as Array<{ outcome?: string }> | undefined) ?? [];
  const counts = summarizeVerificationAttempts(attempts);
  return (
    <div className="node-sub" style={{ marginTop: 4 }} title="Verifier outcome breakdown">
      Verifier · {counts.attempts} attempt{counts.attempts === 1 ? '' : 's'}
      {counts.attempts > 0 ? (
        <div>
          Reproduced {counts.reproduced} · Partial {counts.partial} · Not repro{' '}
          {counts.notReproducible} · Inconclusive {counts.inconclusive}
        </div>
      ) : null}
    </div>
  );
}

function IssuesSummary({ payload }: { payload: Record<string, unknown> }): React.JSX.Element {
  const count = (payload['count'] as number | undefined) ?? 0;
  const findings = (payload['findings'] as Array<{ severity?: string }> | undefined) ?? [];
  if (count === 0) {
    return (
      <div className="node-sub" style={{ marginTop: 4 }}>
        No issues ingested
      </div>
    );
  }
  const breakdown = severityBreakdown(findings);
  return (
    <div className="node-sub" style={{ marginTop: 4 }}>
      {count} created
      <div>
        {breakdown.critical} Critical · {breakdown.high} High · {breakdown.medium} Medium ·{' '}
        {breakdown.low} Low · {breakdown.info} Info
      </div>
    </div>
  );
}

function TargetSummary({ payload }: { payload: Record<string, unknown> }): React.JSX.Element {
  const paths = (payload['includePaths'] as string[] | undefined) ?? [];
  return (
    <div className="node-sub" style={{ marginTop: 4 }}>
      TARGETED · {paths.length} path{paths.length === 1 ? '' : 's'}
      {paths.slice(0, 2).map((p) => (
        <div key={p} className="mono truncate" title={p}>
          {p}
        </div>
      ))}
    </div>
  );
}

function AssessmentSummary({ payload }: { payload: Record<string, unknown> }): React.JSX.Element {
  const outcome = (payload['outcome'] as string | undefined) ?? 'pending';
  return (
    <div className="node-sub" style={{ marginTop: 4 }}>
      {outcome.toUpperCase().replace(/_/g, ' ')}
    </div>
  );
}

function SystemIdSummary({
  payload,
  kind,
}: {
  payload: Record<string, unknown>;
  kind: string;
}): React.JSX.Element {
  const id =
    (payload['name'] as string | undefined) ??
    (payload['id'] as string | undefined) ??
    (payload['revisionId'] as string | undefined) ??
    (payload['snapshotId'] as string | undefined) ??
    '';
  if (id === '') return <span />;
  return (
    <div className="node-sub mono truncate" title={id} style={{ marginTop: 2 }}>
      {kind === 'project' ? id : truncateMiddle(id, 18)}
    </div>
  );
}
