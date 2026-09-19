import React from 'react';
import { truncateMiddle } from '../lib/agent-telemetry.js';

export function CopyId({ id, short = 14 }: { id: string; short?: number }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="mono" title={id}>
      {truncateMiddle(id, short)}{' '}
      <button
        onClick={() => void copy()}
        aria-label={'Copy full ID ' + id}
        title={id}
        style={{ padding: '0 6px', fontSize: 11 }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}
