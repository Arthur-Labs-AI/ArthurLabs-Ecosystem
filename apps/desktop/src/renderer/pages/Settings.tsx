import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

export function Settings(): React.JSX.Element {
  const info = useQuery({ queryKey: ['system-info'], queryFn: () => sentryApi().system.info() });
  const data = info.data as { dataRoot?: string; versions?: Record<string, string> } | undefined;
  const [developerMode, setDeveloperMode] = React.useState(
    () => localStorage.getItem('sentry:developer-mode') === '1',
  );
  React.useEffect(() => {
    localStorage.setItem('sentry:developer-mode', developerMode ? '1' : '0');
  }, [developerMode]);
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Settings</h1>
      <div className="card">
        <h3>Data root</h3>
        <p className="mono">{data?.dataRoot ?? '—'}</p>
        <h3>Versions</h3>
        <pre className="mono">{JSON.stringify(data?.versions ?? {}, null, 2)}</pre>
        <h3>Appearance</h3>
        <p className="muted">
          Dark-first theme is mandatory; light theme is optional and deferred.
        </p>
        <h3>Developer mode</h3>
        <label>
          <input
            type="checkbox"
            checked={developerMode}
            onChange={(e) => setDeveloperMode(e.target.checked)}
          />{' '}
          Enable developer diagnostics
        </label>
        {developerMode ? (
          <p className="mono muted">
            Seed fixtures via: pnpm --filter @qa/desktop seed. Raw event viewer lives in the run
            inspector.
          </p>
        ) : null}
      </div>
    </div>
  );
}
