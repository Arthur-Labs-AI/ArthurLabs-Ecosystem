import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentNodeView } from '../../lib/types.js';
import { statusGlyph } from '../StatusGlyph.js';
import { formatCount, formatElapsed } from '../../lib/agent-telemetry.js';

const ACCENTS: Record<string, string> = {
  stack_muse_main: 'var(--muse)',
  stack_opencode_main: 'var(--opencode, var(--muse))',
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
        {statusGlyph(view.status)} {view.status.toUpperCase()} ·{' '}
        <TickingElapsed ms={view.elapsedMs} status={view.status} />
      </div>
      <div className="node-sub stage-current" title="Current stage">
        <strong>{stageLabel(view.currentStage)}</strong>
      </div>
      <div
        className="node-sub wrap-anywhere"
        style={{ marginTop: 6 }}
        title={view.currentOperation.title}
      >
        <strong>{view.currentOperation.title}</strong>
        {view.currentOperation.detail !== undefined ? (
          <div className="mono wrap-anywhere" title={view.currentOperation.detail}>
            {view.currentOperation.detail}
          </div>
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
      <div className="node-sub" aria-label="Recent activity">
        {view.recentActivity.slice(0, 3).map((activity, index) => (
          <div key={index} className="mono wrap-anywhere" title={activity.title}>
            {activity.title.slice(0, 80)}
          </div>
        ))}
      </div>
      <div className="metrics">
        <span>{formatCount(view.findingsCount)} findings</span>
        <span>{formatCount(view.evidenceCount)} evidence</span>
        {view.turns !== undefined ? <span>{view.turns} turns</span> : null}
        {view.totalTokens !== undefined ? (
          <span>{formatTokens(view.totalTokens)} tokens</span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'runtime':
      return 'RUNTIME VALIDATION';
    case 'working':
      return 'WAITING';
    default:
      return stage.toUpperCase();
  }
}

function formatTokens(total: number): string {
  if (total >= 1000) return Math.round(total / 100) / 10 + 'k';
  return String(total);
}

function ElapsedMs({ ms }: { ms?: number | undefined }): React.JSX.Element {
  return <span>{formatElapsed(ms)}</span>;
}

const TERMINAL_NODE = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);

function TickingElapsed({
  ms,
  status,
}: {
  ms?: number | undefined;
  status: string;
}): React.JSX.Element {
  // Presentation-only 1s clock for active agents: anchor to the last
  // received value and advance with wall-clock time. Nothing persisted.
  const [now, setNow] = React.useState(() => Date.now());
  const anchor = React.useRef<{ ms: number; at: number } | undefined>(undefined);
  const active = !TERMINAL_NODE.has(status);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (ms === undefined) return <ElapsedMs ms={undefined} />;
  const prev = anchor.current;
  if (prev === undefined || prev.ms !== ms) {
    anchor.current = { ms, at: Date.now() };
    return <ElapsedMs ms={ms} />;
  }
  if (!active) return <ElapsedMs ms={ms} />;
  return <ElapsedMs ms={ms + Math.max(0, now - prev.at)} />;
}
