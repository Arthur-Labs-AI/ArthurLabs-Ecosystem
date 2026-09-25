import React from 'react';
import { Check, Copy } from 'lucide-react';
import { truncateMiddle } from '../lib/agent-telemetry.js';

export function CopyId({ id, short = 14 }: { id: string; short?: number }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="copy-chip" title={id}>
      <span className="truncate" style={{ maxWidth: 160 }}>
        {truncateMiddle(id, short)}
      </span>
      <button
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : 'Copy full ID ' + id}
        title={copied ? 'Copied' : 'Copy ' + id}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        {copied ? 'Copied' : ''}
      </button>
    </span>
  );
}
