import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

interface ProviderStatus {
  name: string;
  configured: boolean;
  persistence: string;
  source: string;
  hint: string;
}

const DESCRIPTIONS: Record<string, string> = {
  DEEPSEEK_API_KEY: 'DeepSeek provider key (secret). Used by the DeepSeek harness host process.',
  ANTHROPIC_AUTH_TOKEN:
    'GLM/Claude-Code provider token (secret). Used by the Claude parent process.',
  SENTRY_DEEPSEEK_MODEL: 'DeepSeek model id override (non-secret).',
  SENTRY_GLM_MODEL: 'GLM model id override (non-secret).',
  SENTRY_MUSE_MODEL: 'Muse model id override (non-secret).',
  SENTRY_DEEPSEEK_BINARY:
    'DeepSeek harness executable (non-secret). Absolute path to the dsh entry; needed when the desktop host PATH does not include it.',
  SENTRY_GLM_BINARY: 'GLM harness executable override (non-secret).',
  SENTRY_MUSE_BINARY: 'Muse harness executable override (non-secret).',
};

const SECRET_NAMES: ReadonlySet<string> = new Set(['DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

export function Providers(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState<string | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [confirmForget, setConfirmForget] = React.useState(false);
  const statuses = useQuery({
    queryKey: ['providers'],
    queryFn: () => sentryApi().providers.status(),
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['environment'] });
    void queryClient.invalidateQueries({ queryKey: ['production-readiness'] });
  };
  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));
  const save = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      sentryApi().providers.save(name, value),
    onSuccess: () => {
      setValues({});
      setError(undefined);
      setNote('Saved. Encrypted, persisted, and loaded into the desktop host process.');
      refresh();
    },
    onError: (e) => {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('Secure persistent storage unavailable')) {
        setNote(
          'Secure persistent storage unavailable. Credential can be used for this session only.',
        );
      }
      fail(e);
    },
  });
  const sessionOnly = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      sentryApi().providers.session(name, value),
    onSuccess: () => {
      setValues({});
      setError(undefined);
      setNote('Saved for this session only (not persisted).');
      refresh();
    },
    onError: fail,
  });
  const clear = useMutation({
    mutationFn: (name: string) => sentryApi().providers.clearKey(name),
    onSuccess: () => {
      setError(undefined);
      refresh();
    },
    onError: fail,
  });
  const forgetAll = useMutation({
    mutationFn: () => sentryApi().providers.forgetAll(),
    onSuccess: () => {
      setConfirmForget(false);
      setNote('All provider credentials forgotten. App preferences were preserved.');
      refresh();
    },
    onError: fail,
  });
  // Binary overrides are advanced Linux-runtime paths; hidden from normal settings.
  const list = ((statuses.data as ProviderStatus[] | undefined) ?? []).filter(
    (item) => !item.name.endsWith('_BINARY'),
  );
  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/settings">Settings</Link> / Providers
      </p>
      <h1 style={{ marginTop: 4 }}>Provider keys</h1>
      <p className="muted">
        Save encrypts the credential with the OS keychain, persists it, and loads it into the host
        process immediately — it survives application restarts. Secret values are never displayed
        and never leave the desktop host process.
      </p>
      <p className="muted">
        Muse authenticates via your local <span className="mono">muse login</span> credential store
        — no key to paste here. See <Link to="/environment">Environment</Link> for live readiness.
      </p>
      <HarnessBinaryCard />

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
      {statuses.isLoading ? <div className="skeleton">Loading provider status…</div> : null}
      {list.map((item) => (
        <div key={item.name} className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }} className="mono">
            {item.name}
          </h3>
          <p className="muted">{DESCRIPTIONS[item.name] ?? ''}</p>
          <p>
            Status: <strong>{item.configured ? 'Configured' : 'Missing'}</strong>{' '}
            <span className="muted">({item.hint})</span>
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type={SECRET_NAMES.has(item.name) ? 'password' : 'text'}
              value={values[item.name] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [item.name]: e.target.value }))}
              placeholder={SECRET_NAMES.has(item.name) ? 'Paste new secret value' : 'Enter value'}
              aria-label={'Value for ' + item.name}
              autoComplete="off"
              spellCheck={false}
              style={{ minWidth: 280 }}
            />
            <button
              className="primary"
              disabled={(values[item.name] ?? '').trim().length === 0 || save.isPending}
              onClick={() => save.mutate({ name: item.name, value: values[item.name] ?? '' })}
              title="Encrypt, persist, and load into the host process"
            >
              Save
            </button>
            <button
              disabled={(values[item.name] ?? '').trim().length === 0 || sessionOnly.isPending}
              onClick={() =>
                sessionOnly.mutate({ name: item.name, value: values[item.name] ?? '' })
              }
              title="Memory + process.env only; cleared on quit"
            >
              Use for this session only
            </button>
            <button
              disabled={!item.configured || clear.isPending}
              onClick={() => clear.mutate(item.name)}
            >
              Clear
            </button>
          </div>
        </div>
      ))}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Forget all provider credentials</h3>
        <p className="muted">
          Removes every persisted secret plus session values. Model preferences and unrelated app
          settings are preserved.
        </p>
        {confirmForget ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <span>Forget all credentials?</span>
            <button onClick={() => setConfirmForget(false)}>Keep</button>{' '}
            <button
              className="danger"
              onClick={() => forgetAll.mutate()}
              disabled={forgetAll.isPending}
            >
              Forget all
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmForget(true)}>Forget all provider credentials</button>
        )}
      </div>
    </div>
  );
}

function HarnessBinaryCard(): React.JSX.Element {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Execution runtime</h3>
      <p className="muted">
        Provider CLIs (dsh, Muse, Claude Code) execute inside the WSL2 Sentry runtime on Linux.
        Windows binary paths do not apply — see <Link to="/environment">Environment</Link> for the
        runtime doctor state.
      </p>
    </div>
  );
}
