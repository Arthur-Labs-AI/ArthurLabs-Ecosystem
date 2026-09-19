import React from 'react';

interface State {
  readonly error?: Error | undefined;
}

function toDisplayError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value.length > 0) return new Error(value);
  try {
    return new Error('Render failed: ' + JSON.stringify(value).slice(0, 500));
  } catch {
    return new Error('Render failed with an unknown error');
  }
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'Unknown error';
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return 'Unknown error';
  }
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: unknown): State {
    return { error: toDisplayError(error) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    try {
      console.error('[sentry] render failure', error, info.componentStack);
      const existing = JSON.parse(localStorage.getItem('sentry:last-error') ?? 'null') as unknown;
      void existing;
      localStorage.setItem(
        'sentry:last-error',
        JSON.stringify({
          message: errorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
          at: new Date().toISOString(),
        }).slice(0, 4000),
      );
    } catch {
      // Diagnostics must never break the fallback UI.
    }
  }

  override render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return (
        <div className="error-box" role="alert">
          <h2>Something failed to render</h2>
          <p className="mono">{this.state.error.message}</p>
          <p className="muted">
            The full error was saved to <span className="mono">localStorage sentry:last-error</span>{' '}
            and logged to the console (Ctrl+Shift+I).
          </p>
          <button onClick={() => this.setState({ error: undefined })}>Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}
