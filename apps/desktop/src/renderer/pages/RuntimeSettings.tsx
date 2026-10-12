import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';
import { runtimeConnectionState, useRuntimeStatus } from '../lib/use-runtime-status.js';
import { deriveRuntimeHostView } from '../lib/runtime-host-view.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { StatusPill } from '../components/ui/StatusPill.js';

interface WslDistros {
  distros: Array<{ name: string; state: string; version: number }>;
  preferred: string | null;
  selected: string | null;
  listError?: string;
  hostPlatform?: string;
  executionMode?: string;
  distribution?: { id: string; prettyName: string };
}

interface StatusSlice {
  connected?: boolean;
  distro?: string;
  hostPlatform?: string;
  executionMode?: string;
  distribution?: { id: string; prettyName: string };
}

export function RuntimeSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [note, setNote] = React.useState<string | undefined>(undefined);
  const distros = useQuery({
    queryKey: ['runtime-distros'],
    queryFn: () => sentryApi().runtime.distros(),
  });
  const status = useRuntimeStatus();
  const info = distros.data as WslDistros | undefined;
  const statusInfo = status.data as StatusSlice | undefined;
  const view = deriveRuntimeHostView(statusInfo, info);
  const [selected, setSelected] = React.useState<string | undefined>(undefined);
  const effective = selected ?? info?.selected ?? info?.preferred ?? undefined;
  const connection = runtimeConnectionState(status);
  const connected = connection === 'connected';
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
  const isLinux = view.kind === 'linux';
  return (
    <div className="page">
      <PageHeader
        title={isLinux ? 'Execution Runtime' : 'WSL runtime'}
        subtitle={
          isLinux
            ? 'Sentry executes QA inside a native Linux runtime on this host.'
            : 'Sentry executes QA inside a long-lived WSL2 Linux runtime.'
        }
        crumbs={
          <>
            <Link to="/settings">Settings</Link> / Runtime
          </>
        }
      />
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error}{' '}
          <button className="compact ghost" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {note !== undefined ? (
        <div className="inline-notice" role="status">
          {note}{' '}
          <button className="compact ghost" onClick={() => setNote(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {distros.isLoading ? <div className="skeleton">Loading distributions…</div> : null}
      {view.showDistroSelector && (info?.distros ?? []).length === 0 && !distros.isLoading ? (
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
      <PageSection title={isLinux ? 'Native Runtime' : 'WSL Runtime'}>
        <div className="card">
          <div style={{ marginBottom: 10 }}>
            <StatusPill
              status={connection === 'checking' ? 'checking' : connected ? 'connected' : 'offline'}
              label={
                connection === 'checking'
                  ? 'Checking runtime…'
                  : connected
                    ? 'Connected'
                    : 'Offline'
              }
              pulse={connected}
            />
          </div>
          <dl className="kv">
            <dt>Host</dt>
            <dd>{view.hostLabel ?? '—'}</dd>
            <dt>Execution</dt>
            <dd>{view.executionLabel ?? '—'}</dd>
            <dt>{isLinux ? 'Distribution' : 'Current'}</dt>
            <dd>
              {isLinux ? (view.distroLabel ?? '—') : (info?.selected ?? info?.preferred ?? '—')}
            </dd>
          </dl>
          {view.showDistroSelector ? (
            <>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  marginTop: 10,
                }}
              >
                <select
                  value={effective ?? ''}
                  onChange={(e) => setSelected(e.target.value)}
                  aria-label="Change distribution"
                >
                  {(info?.distros ?? []).map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name} (WSL{d.version}, {d.state})
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={
                    effective === undefined || effective === (info?.preferred ?? info?.selected)
                  }
                  onClick={() => {
                    if (effective !== undefined) void save(effective);
                  }}
                >
                  Save distribution
                </button>
              </div>
              <p className="metadata" style={{ marginBottom: 0 }}>
                Changing the distribution takes effect on the next application start; the runtime
                reconnects automatically. Changes require restart.
              </p>
            </>
          ) : (
            <p className="metadata" style={{ marginBottom: 0 }}>
              The native runtime follows the current host; no distribution selection is needed.
            </p>
          )}
        </div>
      </PageSection>
    </div>
  );
}
