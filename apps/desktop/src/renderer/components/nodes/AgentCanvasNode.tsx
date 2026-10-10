import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentNodeView } from '../../lib/types.js';
import { statusGlyph } from '../StatusGlyph.js';
import { dotClassForStatus } from '../ui/StatusPill.js';
import { formatCount, formatElapsed } from '../../lib/agent-telemetry.js';

const ACCENTS: Record<string, string> = {
  stack_muse_main: 'var(--muse)',
  stack_opencode_main: 'var(--opencode, var(--muse))',
  stack_deepseek_main: 'var(--deepseek)',
  stack_glm_main: 'var(--glm)',
};

function stageTone(state: string): string {
  switch (state) {
    case 'completed':
      return 'done';
    case 'active':
      return 'active';
    case 'failed':
      return 'failed';
    default:
      return '';
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
        <div className="node-sub">
          Configured · {data['status'] === 'not_started' ? 'Not started' : 'Waiting'}
        </div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }
  const activeLine =
    !['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(view.status) &&
    view.currentOperation.title !== undefined &&
    view.currentOperation.title !== ''
      ? view.currentOperation.title
      : undefined;
  return (
    <div
      className={'flow-node' + ((data['selected'] as boolean) ? ' selected' : '')}
      style={{ borderTop: '2px solid ' + accent }}
      aria-label={view.displayName + ' ' + view.status}
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-title">
        <span className={dotClassForStatus(view.status)} aria-hidden="true" />
        {view.displayName}
        <span className="faint" aria-hidden="true" style={{ marginLeft: 'auto' }}>
          {statusGlyph(view.status)}
        </span>
      </div>
      <div className="node-model" title={view.model}>
        {view.model}
      </div>
      <div className="node-sub">
        {view.status.toUpperCase()} · <TickingElapsed ms={view.elapsedMs} status={view.status} />
      </div>
      <div
        className="stage-dots"
        role="img"
        aria-label={
          'Stage: ' + view.stages.map((stage) => stage.label + ' ' + stage.state).join(', ')
        }
      >
        {view.stages.map((stage) => (
          <i
            key={stage.id}
            className={stageTone(stage.state)}
            title={stage.label + ' — ' + stage.state}
          />
        ))}
      </div>
      {activeLine !== undefined ? (
        <div className="node-sub truncate" title={activeLine} style={{ marginTop: 6 }}>
          {activeLine}
        </div>
      ) : null}
      <div className="metrics">
        <span className="metric-chip" title="Findings reported by this agent">
          {formatCount(view.findingsCount)} findings
        </span>
        <span className="metric-chip" title="Evidence records captured by this agent">
          {formatCount(view.evidenceCount)} evidence
        </span>
        <span className="metric-chip" title="Elapsed time">
          {formatElapsed(view.elapsedMs)}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
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
