import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
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
      {kind === 'target' ? <TargetSummary payload={payload} /> : null}
      {kind === 'project' || kind === 'revision' || kind === 'snapshot' ? (
        <SystemIdSummary payload={payload} kind={kind} />
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function TargetSummary({ payload }: { payload: Record<string, unknown> }): React.JSX.Element {
  const paths = (payload['includePaths'] as string[] | undefined) ?? [];
  return (
    <div className="node-sub" style={{ marginTop: 4 }}>
      {'TARGETED · ' + paths.length + ' path' + (paths.length === 1 ? '' : 's')}
      {paths.slice(0, 2).map((p) => (
        <div key={p} className="mono truncate" title={p}>
          {p}
        </div>
      ))}
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
