import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentNodeView } from '../../lib/types.js';
import { statusGlyph } from '../StatusGlyph.js';
import { formatCount, formatElapsed } from '../../lib/agent-telemetry.js';

const ACCENTS: Record<string, string> = {
  stack_muse_main: 'var(--muse)',
  stack_deepseek_main: 'var(--deepseek)',
  stack_glm_main: 'var(--glm)',
};

function stageMark(state: string): string {
  switch (state) {
    case 'completed':
      return '\u2713';
    case 'active':
      return '\u25CF';
    case 'failed':
      return '\u00D7';
    case 'cancelled':
      return '\u25A0';
    case 'warning':
      return '!';
    default:
      return '\u25CB';
  }
}

export function AgentCanvasNode({ data }: NodeProps): React.JSX.Element {
  const payload = data['payload'] as { view?: AgentNodeView; agentStackId?: string } | undefined;
  const view = payload?.view;
  const accent = ACCENTS[payload?.agentStackId ?? ''] ?? 'var(--accent)';
  const title = (data['label'] as string) ?? 'Agent';
  if (view === undefined) {
    return (
      <div className="flow-node" style={{ borderTop: '2px solid ' + accent }}>
        <Handle type="target" position={Position.Top} />
        <div className="node-title">{title}</div>
        <div className="node-sub">Configured · Waiting</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }
  return (
    <div
      className={'flow-node' + ((data['selected'] as boolean) ? ' selected' : '')}
      style={{ borderTop: '2px solid ' + accent }}
      aria-label={view.displayName + ' ' + view.status}
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-title">
        <span
          className={
            'status-dot ' +
            (view.status === 'completed'
              ? 'status-completed'
              : view.status === 'failed'
                ? 'status-failed'
                : view.status === 'cancelled'
                  ? 'status-cancelled'
                  : 'status-running') +
            (['running', 'planning', 'starting'].includes(view.status) ? ' pulse' : '')
          }
        />
        {view.displayName}
      </div>
      <div className="node-sub mono">{view.model}</div>
      <div className="node-sub">
        {statusGlyph(view.status)} {view.status.toUpperCase()} · <ElapsedMs ms={view.elapsedMs} />
      </div>
      <div className="node-sub" style={{ marginTop: 6 }}>
        <strong>{view.currentOperation.title}</strong>
        {view.currentOperation.detail !== undefined ? (
          <div className="mono">{view.currentOperation.detail}</div>
        ) : null}
      </div>
      <div className="stages" aria-label="Stage progression">
        {view.stages.slice(1, 6).map((stage) => (
          <div key={stage.id} className="stage">
            <span aria-hidden="true">{stageMark(stage.state)}</span>
            <span className={stage.state === 'active' ? '' : 'muted'}>{stage.label}</span>
          </div>
        ))}
      </div>
      <div className="metrics">
        <span>{formatCount(view.findingsCount)} findings</span>
        <span>{formatCount(view.evidenceCount)} evidence</span>
        {view.turns !== undefined ? <span>{view.turns} turns</span> : null}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function ElapsedMs({ ms }: { ms?: number | undefined }): React.JSX.Element {
  return <span>{formatElapsed(ms)}</span>;
}
