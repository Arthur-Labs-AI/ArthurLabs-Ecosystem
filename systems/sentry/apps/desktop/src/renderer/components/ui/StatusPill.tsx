import React from 'react';
import { StatusIcon, statusVisual } from '../StatusGlyph.js';

export type StatusTone = 'success' | 'info' | 'thinking' | 'warning' | 'danger' | 'muted';

export function toneForStatus(status: string): StatusTone {
  return statusVisual(status).tone;
}

export function dotClassForStatus(status: string): string {
  const visual = statusVisual(status);
  if (visual.tone === 'success') return 'status-dot status-completed';
  if (visual.tone === 'danger') return 'status-dot status-failed';
  if (visual.tone === 'warning') return 'status-dot status-partial';
  if (visual.tone === 'thinking') return 'status-dot status-thinking';
  if (visual.spin === true) return 'status-dot status-running';
  return 'status-dot status-cancelled';
}

export function StatusPill({
  status,
  label,
  pulse,
}: {
  status: string;
  label?: string;
  pulse?: boolean;
}): React.JSX.Element {
  const tone = toneForStatus(status);
  return (
    <span className={'status-pill tone-' + tone} title={status}>
      <StatusIcon status={status} className={pulse === true && tone === 'info' ? 'breathe' : ''} />
      {label ?? status}
    </span>
  );
}
