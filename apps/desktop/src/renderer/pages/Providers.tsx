import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

interface ProviderStatus {
  name: string;
  configured: boolean;
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
};

const SECRET_NAMES: ReadonlySet<string> = new Set(['DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

export function Providers(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState<string | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const statuses = useQuery({
    queryKey: ['providers'],
    queryFn: () => sentryApi().providers.status(),
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['environment'] });
  };
  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));
  const save = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      sentryApi().providers.setKey(name, value),
    onSuccess: (_result, input) => {
      setValues((prev) => ({ ...prev, [input.name]: '' }));
      setError(undefined);
      setNote('Saved for this session. Values never leave the desktop host process.');
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
  const persist = useMutation({
    mutationFn: () => sentryApi().providers.persist(),
    onSuccess: (result) => {
      const info = result as { path?: string; keys?: number };
      setNote(
        'Persisted ' +
          String(info.keys ?? 0) +
          ' value(s) to the user-level env file: ' +
          String(info.path ?? ''),
      );
      refresh();
    },
    onError: fail,
  });
  const forget = useMutation({
    mutationFn: () => sentryApi().providers.forgetFile(),
    onSuccess: () => {
      setNote('Persisted env file removed. Session values remain until restart.');
      refresh();
    },
    onError: fail,
  });
  const list = (statuses.data as ProviderStatus[] | undefined) ?? [];
  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/settings">Settings</Link> / Providers
      </p>
      <h1 style={{ marginTop: 4 }}>Provider keys</h1>
      <p className="muted">
        Values apply to this desktop session immediately (harness discovery reads them from the host
        environment). Persisting writes them to a user-level env file outside the Sentry data root —
        never into the database or git. The UI only ever shows configured/missing plus a last-4 hint
        for secrets.
      </p>
      <p className="muted">
        Muse authenticates via your local <span className="mono">muse login</span> credential store
        — no key to paste here. See <Link to="/environment">Environment</Link> for live readiness.
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
      {statuses.isLoading ? <div className="skeleton">Loading provider status…</div> : null}
      {list.map((item) => (
        <div key={item.name} className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }} className="mono">
            {item.name}
          </h3>
          <p className="muted">{DESCRIPTIONS[item.name] ?? ''}</p>
          <p>
            Status: <strong>{item.configured ? 'Configured' : 'Missing'}</strong>{' '}
            <span className="muted">
              (source: {item.source}; hint: <span className="mono">{item.hint}</span>)
            </span>
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
            >
              Save for session
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
        <h3 style={{ marginTop: 0 }}>Persistence</h3>
        <p className="muted">
          Keep values only in memory (cleared on quit), or persist them to the user-level env file
          so they reload on next launch.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled={persist.isPending} onClick={() => persist.mutate()}>
            Persist to user env file
          </button>
          <button disabled={forget.isPending} onClick={() => forget.mutate()}>
            Remove persisted file
          </button>
        </div>
      </div>
    </div>
  );
}
