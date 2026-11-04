import React from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

export interface ToastItem {
  readonly id: number;
  readonly tone: 'success' | 'danger' | 'info';
  readonly title: string;
  readonly body?: string;
  readonly action?: React.ReactNode;
}

function ToneIcon({ tone }: { tone: ToastItem['tone'] }): React.JSX.Element {
  if (tone === 'success')
    return (
      <span className="status-icon tone-success" aria-hidden="true">
        <CheckCircle2 size={16} aria-hidden />
      </span>
    );
  if (tone === 'danger')
    return (
      <span className="status-icon tone-danger" aria-hidden="true">
        <XCircle size={16} aria-hidden />
      </span>
    );
  return (
    <span className="status-icon tone-info" aria-hidden="true">
      <Info size={16} aria-hidden />
    </span>
  );
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastItem[];
  onDismiss: (id: number) => void;
}): React.JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={'toast tone-' + toast.tone} role="status">
          <ToneIcon tone={toast.tone} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{toast.title}</strong>
            {toast.body !== undefined ? (
              <div className="mono wrap-anywhere metadata">{toast.body}</div>
            ) : null}
            {toast.action}
          </div>
          <button
            className="icon-btn ghost"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
