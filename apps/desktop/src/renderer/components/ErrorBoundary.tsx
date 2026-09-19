import React from 'react';

interface State {
  readonly error?: Error | undefined;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return (
        <div className="error-box" role="alert">
          <h2>Something failed to render</h2>
          <p className="mono">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: undefined })}>Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}
