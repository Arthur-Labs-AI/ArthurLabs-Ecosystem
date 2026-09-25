import React from 'react';

export interface ToastItem {
  readonly id: number;
  readonly tone: 'success' | 'danger' | 'info';
  readonly title: string;
  readonly body?: string;
  readonly action?: React.ReactNode;
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
          <span aria-hidden="true">
            {toast.tone === 'success' ? '\u2713' : toast.tone === 'danger' ? '\u00D7' : '\u2139'}
          </span>
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
            \u00D7
          </button>
        </div>
      ))}
    </div>
  );
}
