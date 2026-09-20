import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

interface WslDistros {
  distros: Array<{ name: string; state: string; version: number }>;
  preferred: string | null;
  selected: string | null;
  listError?: string;
}

export function RuntimeSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [note, setNote] = React.useState<string | undefined>(undefined);
  const distros = useQuery({
    queryKey: ['runtime-distros'],
    queryFn: () => sentryApi().runtime.distros(),
  });
  const status = useQuery({
    queryKey: ['runtime-status'],
    queryFn: () => sentryApi().runtime.status(),
    refetchInterval: 5000,
  });
  const info = distros.data as WslDistros | undefined;
  const [selected, setSelected] = React.useState<string | undefined>(undefined);
  const effective = selected ?? info?.selected ?? info?.preferred ?? undefined;
  const save = async (distro: string): Promise<void> => {
    try {
      setError(undefined);
      await sentryApi().runtime.selectDistro(distro);
      setNote('Distribution saved. Restart Sentry Desktop to reconnect the runtime.');
      void queryClient.invalidateQueries({ queryKey: ['runtime-distros'] });
      void queryClient.invalidateQueries({ queryKey: ['runtime-status'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/settings">Settings</Link> / Runtime
      </p>
      <h1 style={{ marginTop: 4 }}>WSL runtime</h1>
      <p className="muted">
        Sentry executes QA inside a long-lived WSL2 Linux runtime. Changing the distribution takes
        effect on the next application start; the runtime reconnects automatically.
      </p>
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error} <button onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      ) : null}
      {note !== undefined ? (
        <div className="card" style={{ marginBottom: 12 }}>
          {note} <button onClick={() => setNote(undefined)}>Dismiss</button>
        </div>
      ) : null}
      {distros.isLoading ? <div className="skeleton">Loading distributions…</div> : null}
      {(info?.distros ?? []).length === 0 && !distros.isLoading ? (
        <div className="error-box" role="alert">
          {info?.listError !== undefined ? (
            <span>
              Could not list WSL distributions: {info.listError} — the runtime itself is still
              connected, so retry this page or restart Sentry.
            </span>
          ) : (
            <span>
              No usable WSL2 distribution found. Install Ubuntu (wsl --install -d Ubuntu) and
              restart Sentry. See docs/setup/wsl-runtime.md.
            </span>
          )}
        </div>
      ) : null}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Distribution</h3>
        <select
          value={effective ?? ''}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="WSL distribution"
        >
          {(info?.distros ?? []).map((d) => (
            <option key={d.name} value={d.name}>
              {d.name} (WSL{d.version}, {d.state})
            </option>
          ))}
        </select>{' '}
        <button
          className="primary"
          disabled={effective === undefined || effective === (info?.preferred ?? info?.selected)}
          onClick={() => {
            if (effective !== undefined) void save(effective);
          }}
        >
          Save distribution
        </button>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Status</h3>
        <p className="mono muted">
          {(status.data as { connected?: boolean } | undefined)?.connected === true
            ? 'Connected'
            : 'Offline'}
        </p>
      </div>
    </div>
  );
}
