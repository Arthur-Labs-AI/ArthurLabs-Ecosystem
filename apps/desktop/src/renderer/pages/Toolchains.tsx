import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { StatusPill } from '../components/ui/StatusPill.js';
import type { ToolchainPackStatus } from '../../shared/ipc-contract.js';

const POLL_MS = 3000;

function totalInstallMb(pack: ToolchainPackStatus): number {
  return pack.versions.filter((v) => !v.installed).length * pack.approxSizeMb;
}

/**
 * Optional language toolchains. They install on the host (with its network) into a
 * Sentry-managed folder, one folder per version, and are never installed by agent code.
 */
export function Toolchains(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [message, setMessage] = React.useState<string | undefined>(undefined);
  const status = useQuery({
    queryKey: ['toolchains'],
    queryFn: () => sentryApi().toolchains.status(),
    refetchInterval: (query) =>
      (query.state.data as ToolchainPackStatus[] | undefined)?.some((p) =>
        p.versions.some((v) => v.installing),
      )
        ? POLL_MS
        : false,
  });
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['toolchains'] });
  const install = useMutation({
    mutationFn: (input: { packId: string; version: string }) =>
      sentryApi().toolchains.install(input.packId, input.version),
    onSuccess: () => setMessage(undefined),
    onError: (e) => setMessage(e instanceof Error ? e.message : String(e)),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (input: { packId: string; version: string }) =>
      sentryApi().toolchains.remove(input.packId, input.version),
    onError: (e) => setMessage(e instanceof Error ? e.message : String(e)),
    onSettled: refresh,
  });
  const installAll = (pack: ToolchainPackStatus): void => {
    const missing = pack.versions.filter((v) => !v.installed && !v.installing);
    const mb = totalInstallMb(pack);
    if (
      missing.length > 0 &&
      window.confirm(
        'Install ' +
          missing.length +
          ' version(s) of ' +
          pack.label +
          '? About ' +
          mb +
          ' MB in total.',
      )
    )
      for (const v of missing) install.mutate({ packId: pack.id, version: v.version });
  };
  return (
    <div className="page">
      <PageHeader
        title="Toolchains"
        subtitle="Language toolchains installed on this machine for the agents to use."
      />
      <PageSection title="Install">
        <p className="body-secondary" style={{ marginTop: 0 }}>
          Each version installs into its own folder inside Sentry&apos;s data folder, using this
          machine&apos;s network. Nothing installs until you press a button.{' '}
          <Link to="/settings">Back to Settings</Link>
        </p>
        {message !== undefined ? (
          <p className="error-box" role="alert">
            {message}
          </p>
        ) : null}
        <div className="cards">
          {(status.data ?? []).map((pack) => (
            <div className="card" key={pack.id}>
              <h3 className="card-title">{pack.label}</h3>
              <p className="body-secondary" style={{ marginTop: 0 }}>
                {pack.description} About {pack.approxSizeMb} MB per version.
              </p>
              {pack.note !== undefined ? <p className="metadata">{pack.note}</p> : null}
              {pack.versions.map((v) => (
                <div
                  key={v.version}
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    margin: '6px 0',
                  }}
                >
                  <span style={{ minWidth: 70 }}>
                    {v.version}
                    {v.version === pack.defaultVersion ? ' (default)' : ''}
                  </span>
                  <StatusPill
                    status={v.installing ? 'running' : v.installed ? 'completed' : 'cancelled'}
                    label={
                      v.installing ? 'Installing…' : v.installed ? 'Installed' : 'Not installed'
                    }
                  />
                  {v.installed && v.sizeMb !== undefined ? (
                    <span className="metadata">{v.sizeMb} MB</span>
                  ) : null}
                  {v.installed ? (
                    <button
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ packId: pack.id, version: v.version })}
                      aria-label={'Remove ' + pack.label + ' ' + v.version}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      disabled={v.installing}
                      onClick={() => install.mutate({ packId: pack.id, version: v.version })}
                      aria-label={'Install ' + pack.label + ' ' + v.version}
                    >
                      Install
                    </button>
                  )}
                  {v.error !== undefined && !v.installing ? (
                    <pre
                      className="error-box mono"
                      style={{ flexBasis: '100%', whiteSpace: 'pre-wrap' }}
                    >
                      {v.error}
                    </pre>
                  ) : null}
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <button
                  className="primary"
                  disabled={pack.versions.every((v) => v.installed || v.installing)}
                  onClick={() => installAll(pack)}
                >
                  Install all {pack.label} versions
                </button>
              </div>
            </div>
          ))}
          {status.isLoading ? <span className="muted">Loading…</span> : null}
        </div>
      </PageSection>
    </div>
  );
}
