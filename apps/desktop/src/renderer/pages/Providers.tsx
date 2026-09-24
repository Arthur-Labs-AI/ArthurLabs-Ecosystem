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
  OPENROUTER_API_KEY:
    'OpenRouter provider key (secret). Used by the OpenCode harness host process inside the WSL runtime. Never shown, never leaves the desktop host process except over the encrypted runtime channel.',
  SENTRY_OPENCODE_MODEL:
    'OpenCode model id (non-secret). An exact OpenRouter model id, e.g. anthropic/claude-opus-4-6. The harness is OpenCode, the provider is OpenRouter, the model is your selection.',
  DEEPSEEK_API_KEY: 'DeepSeek provider key (secret). Used by the DeepSeek harness host process.',
  ANTHROPIC_AUTH_TOKEN:
    'GLM/Claude-Code provider token (secret). Used by the Claude parent process.',
  ANTHROPIC_BASE_URL:
    'GLM endpoint override (non-secret). Trusted Z.AI Anthropic-compatible base URL, e.g. https://api.z.ai/api/anthropic.',
  SENTRY_DEEPSEEK_MODEL: 'DeepSeek model id override (non-secret).',
  SENTRY_GLM_MODEL: 'GLM model id override (non-secret).',
  SENTRY_DEEPSEEK_BINARY:
    'DeepSeek harness executable (non-secret). Absolute path to the dsh entry; needed when the desktop host PATH does not include it.',
  SENTRY_GLM_BINARY: 'GLM harness executable override (non-secret).',
  SENTRY_OPENCODE_BINARY: 'OpenCode harness executable override (non-secret).',
  OPENCODE_API_KEY:
    'OpenCode Zen provider key (secret). Used when the OpenCode provider is opencode.',
  SENTRY_OPENCODE_PROVIDER:
    'OpenCode upstream provider (non-secret): openrouter or opencode (Zen).',
};

const SECRET_NAMES: ReadonlySet<string> = new Set([
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

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
      <HarnessBinaryCard
        statuses={(statuses.data as ProviderStatus[] | undefined) ?? []}
        values={values}
        setValues={setValues}
        onSave={(name, value) => save.mutate({ name, value })}
        onClear={(name) => clear.mutate(name)}
        savePending={save.isPending}
        clearPending={clear.isPending}
        onError={fail}
      />

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

const BINARY_FIELDS = [
  { name: 'SENTRY_OPENCODE_BINARY', label: 'OpenCode executable' },
  { name: 'SENTRY_DEEPSEEK_BINARY', label: 'DeepSeek executable' },
  { name: 'SENTRY_GLM_BINARY', label: 'Claude Code executable' },
] as const;

function HarnessBinaryCard(props: {
  readonly statuses: ProviderStatus[];
  readonly values: Record<string, string>;
  readonly setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  readonly onSave: (name: string, value: string) => void;
  readonly onClear: (name: string) => void;
  readonly savePending: boolean;
  readonly clearPending: boolean;
  readonly onError: (e: unknown) => void;
}): React.JSX.Element {
  const looksWindowsPath = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value.trim());
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Execution runtime</h3>
      <p className="muted">
        Provider CLIs (opencode, dsh, Claude Code) execute inside the WSL2 Sentry runtime on Linux.
        Optional absolute Linux paths below override PATH lookup; leaving a field empty keeps
        automatic discovery. Paths refer to the selected WSL Linux runtime — Windows paths (C:\…) do
        not apply. See <Link to="/environment">Environment</Link> for the runtime doctor state.
      </p>
      {BINARY_FIELDS.map((field) => {
        const status = props.statuses.find((s) => s.name === field.name);
        const current = props.values[field.name] ?? '';
        const windowsPath = looksWindowsPath(current);
        return (
          <div key={field.name} style={{ marginBottom: 12 }}>
            <strong>{field.label}</strong>{' '}
            <span className="muted">
              ({status?.configured === true ? 'Configured' : 'Not set'}
              {status?.hint !== undefined && status.hint.length > 0 ? '; ' + status.hint : ''})
            </span>
            <p className="muted" style={{ margin: '4px 0' }}>
              {DESCRIPTIONS[field.name] ?? ''}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                value={current}
                onChange={(e) =>
                  props.setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                }
                placeholder="/home/…/.local/share/sentry/tools/opencode/node_modules/.bin/opencode"
                aria-label={'Value for ' + field.name}
                autoComplete="off"
                spellCheck={false}
                style={{ minWidth: 280 }}
              />
              <button
                className="primary"
                disabled={current.trim().length === 0 || windowsPath || props.savePending}
                onClick={() => {
                  if (windowsPath) {
                    props.onError(
                      new Error(field.label + ': use an absolute Linux path, not a Windows path.'),
                    );
                    return;
                  }
                  props.onSave(field.name, current);
                }}
                title="Persist and load into the runtime (no restart needed)"
              >
                Save
              </button>
              <button
                disabled={status?.configured !== true || props.clearPending}
                onClick={() => props.onClear(field.name)}
              >
                Clear
              </button>
            </div>
            {windowsPath ? (
              <p className="error-box" style={{ marginTop: 4 }}>
                Windows paths do not apply inside the Linux runtime — enter an absolute Linux path
                (e.g. /home/…/opencode).
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
