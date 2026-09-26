import React from 'react';

export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'muted';

export function toneForStatus(status: string): StatusTone {
  const key = status.toLowerCase();
  if (key.includes('complet') || key === 'ready' || key === 'connected' || key === 'passed')
    return 'success';
  if (key.includes('fail') || key.includes('error')) return 'danger';
  if (key.includes('cancel') || key.includes('interrupt')) return 'muted';
  if (key.includes('partial') || key.includes('warn') || key === 'degraded') return 'warning';
  if (key.includes('inconclusive')) return 'warning';
  return 'info';
}

export function dotClassForStatus(status: string): string {
  const key = status.toLowerCase();
  if (key.includes('complet')) return 'status-dot status-completed';
  if (key.includes('fail') || key.includes('error')) return 'status-dot status-failed';
  if (key.includes('cancel') || key.includes('interrupt')) return 'status-dot status-cancelled';
  if (key.includes('partial') || key.includes('warn') || key.includes('inconclusive'))
    return 'status-dot status-partial';
  return 'status-dot status-running';
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
      <span
        className={dotClassForStatus(status) + (pulse === true ? ' pulse' : '')}
        aria-hidden="true"
      />
      {label ?? status}
    </span>
  );
}
