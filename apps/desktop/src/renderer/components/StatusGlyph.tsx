import React from 'react';

const GLYPHS: Record<string, string> = {
  completed: '\u2713',
  partial: '!',
  failed: '\u00D7',
  cancelled: '\u25A0',
  inconclusive: '?',
  running: '\u25CF',
  active: '\u25CF',
};

export function statusGlyph(status: string): string {
  const key = status.toLowerCase();
  if (key in GLYPHS) return GLYPHS[key] as string;
  if (key.includes('cancel')) return '\u25A0';
  if (key.includes('fail') || key.includes('error')) return '\u00D7';
  if (key.includes('partial') || key.includes('warn')) return '!';
  if (key.includes('inconclusive')) return '?';
  if (key.includes('complet')) return '\u2713';
  return '\u25CF';
}

export function StatusLabel({ status }: { status: string }): React.JSX.Element {
  const glyph = statusGlyph(status);
  const tone = toneFor(status);
  return (
    <span>
      <span className={'status-dot ' + tone} aria-hidden="true" /> {glyph} {status}
    </span>
  );
}

function toneFor(status: string): string {
  const key = status.toLowerCase();
  if (key.includes('complet')) return 'status-completed';
  if (key.includes('fail') || key.includes('error')) return 'status-failed';
  if (key.includes('cancel') || key.includes('interrupt')) return 'status-cancelled';
  if (key.includes('partial') || key.includes('warn')) return 'status-partial';
  if (key.includes('inconclusive')) return 'status-inconclusive';
  return 'status-running';
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
