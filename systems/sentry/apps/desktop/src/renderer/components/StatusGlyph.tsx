import React from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  CircleDashed,
  Clock3,
  HelpCircle,
  Loader2,
  OctagonPause,
  TimerOff,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

/**
 * Legacy text glyphs. Retained for backwards compatibility with older
 * call sites; new UI should render the animated <StatusIcon /> instead.
 */
const GLYPHS: Record<string, string> = {
  completed: '✓',
  partial: '!',
  failed: '×',
  cancelled: '■',
  inconclusive: '?',
  running: '●',
  active: '●',
};

export function statusGlyph(status: string): string {
  const key = status.toLowerCase();
  if (key in GLYPHS) return GLYPHS[key] as string;
  if (key.includes('cancel')) return '■';
  if (key.includes('fail') || key.includes('error')) return '×';
  if (key.includes('partial') || key.includes('warn')) return '!';
  if (key.includes('inconclusive')) return '?';
  if (key.includes('complet')) return '✓';
  return '●';
}

export type StatusIconTone = 'success' | 'danger' | 'warning' | 'info' | 'thinking' | 'muted';

interface StatusVisual {
  readonly Icon: LucideIcon;
  readonly tone: StatusIconTone;
  readonly spin?: boolean;
  readonly breathe?: boolean;
}

/**
 * Map any Sentry status vocabulary (run, agent run, stage, readiness,
 * verification) onto one polished animated icon. Text always accompanies
 * the icon, so icons are decorative (aria-hidden) and states remain
 * screen-reader truthful.
 */
export function statusVisual(status: string): StatusVisual {
  const key = status.toLowerCase();
  // Terminal outcomes take precedence over phase names (e.g. reporting_failed).
  if (key.includes('fail') || key.includes('error') || key === 'blocked')
    return { Icon: XCircle, tone: 'danger' };
  if (key.includes('cancel') || key.includes('interrupt') || key.includes('abort'))
    return { Icon: OctagonPause, tone: 'muted' };
  if (key.includes('partial') || key.includes('warn') || key === 'degraded')
    return { Icon: AlertTriangle, tone: 'warning' };
  if (key.includes('timed_out') || key.includes('timeout'))
    return { Icon: TimerOff, tone: 'warning' };
  if (key.includes('inconclusive')) return { Icon: HelpCircle, tone: 'warning' };
  if (
    key.includes('complet') ||
    key === 'ready' ||
    key === 'connected' ||
    key === 'passed' ||
    key === 'fixed'
  )
    return { Icon: CheckCircle2, tone: 'success' };
  if (
    [
      'not_started',
      'pending',
      'idle',
      'inactive',
      'offline',
      'unavailable',
      'unknown',
      'unverified',
    ].includes(key)
  )
    return { Icon: CircleDashed, tone: 'muted' };
  if (key.includes('plan') || key.includes('think') || key.includes('report'))
    return { Icon: Brain, tone: 'thinking', breathe: true };
  if (
    key.includes('running') ||
    key === 'running' ||
    key.includes('active') ||
    key === 'in_progress' ||
    key.includes('probing')
  )
    return { Icon: Loader2, tone: 'info', spin: true };
  if (key.includes('queue') || key.includes('wait') || key.includes('start'))
    return { Icon: Clock3, tone: 'muted', breathe: true };
  if (key.includes('not_started') || key.includes('pending') || key.includes('idle'))
    return { Icon: CircleDashed, tone: 'muted' };
  return { Icon: CircleDashed, tone: 'info' };
}

export function StatusIcon({
  status,
  size = 13,
  className = '',
}: {
  status: string;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const visual = statusVisual(status);
  const classes =
    'status-icon tone-' +
    visual.tone +
    (visual.spin === true ? ' spin' : '') +
    (visual.breathe === true ? ' breathe' : '') +
    (className === '' ? '' : ' ' + className);
  return (
    <span className={classes} aria-hidden="true">
      <visual.Icon size={size} aria-hidden />
    </span>
  );
}

/**
 * Normalized lifecycle class for canvas nodes and other state-driven
 * surfaces: idle / starting / thinking / running / completed / failed /
 * timeout / cancelled. Drives glows, beams, and halos in CSS.
 */
export function nodeStateClass(status: string): string {
  const visual = statusVisual(status);
  if (visual.tone === 'danger') return 'state-failed';
  if (visual.tone === 'warning') return 'state-timeout';
  if (visual.tone === 'success') return 'state-completed';
  if (visual.tone === 'thinking') return 'state-thinking';
  if (visual.spin === true) return 'state-running';
  if (status.toLowerCase() === 'starting') return 'state-starting';
  if (/cancel|interrupt|abort/.test(status.toLowerCase())) return 'state-cancelled';
  return 'state-idle';
}

export function StatusLabel({ status }: { status: string }): React.JSX.Element {
  return (
    <span className="status-label">
      <StatusIcon status={status} size={13} /> {status}
    </span>
  );
}

export function Elapsed({ ms }: { ms?: number }): React.JSX.Element {
  if (ms === undefined) return <span>--:--</span>;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0)
    return (
      <span>
        {hours}h {pad(minutes)}m
      </span>
    );
  return (
    <span>
      {pad(minutes)}:{pad(seconds)}
    </span>
  );
}
