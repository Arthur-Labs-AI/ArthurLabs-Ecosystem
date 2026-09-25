import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';
import { PageHeader } from '../components/ui/PageHeader.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';

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
    'OpenCode upstream provider (non-secret): openrouter, opencode (Zen), or opencode-go (Go subscription gateway).',
};

const SECRET_NAMES: ReadonlySet<string> = new Set([
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

interface AgentCardSpec {
  readonly title: string;
  readonly subtitle: string;
  readonly fields: ReadonlyArray<{ name: string; label: string }>;
}

const AGENT_CARDS: readonly AgentCardSpec[] = [
  {
    title: 'OpenCode',
    subtitle: 'Primary coding agent · OpenRouter or Zen transport',
    fields: [
      { name: 'SENTRY_OPENCODE_PROVIDER', label: 'Provider' },
      { name: 'SENTRY_OPENCODE_MODEL', label: 'Model' },
      { name: 'OPENROUTER_API_KEY', label: 'API key' },
      { name: 'OPENCODE_API_KEY', label: 'Zen API key' },
    ],
  },
  {
    title: 'DeepSeek',
    subtitle: 'Second reviewer · DeepSeek API',
    fields: [
      { name: 'SENTRY_DEEPSEEK_MODEL', label: 'Model' },
      { name: 'DEEPSEEK_API_KEY', label: 'API key' },
    ],
  },
  {
    title: 'GLM',
    subtitle: 'Third reviewer · Claude Code harness on Z.AI endpoint',
    fields: [
      { name: 'SENTRY_GLM_MODEL', label: 'Model' },
      { name: 'ANTHROPIC_BASE_URL', label: 'Endpoint' },
      { name: 'ANTHROPIC_AUTH_TOKEN', label: 'Token' },
    ],
  },
];

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
  const byName = new Map(
    ((statuses.data as ProviderStatus[] | undefined) ?? []).map((item) => [item.name, item]),
  );
  const fieldProps = {
    values,
    setValues,
    onSave: (name: string, value: string) => save.mutate({ name, value }),
    onClear: (name: string) => clear.mutate(name),
    savePending: save.isPending,
    clearPending: clear.isPending,
    byName,
  };
  return (
    <div className="page">
      <PageHeader
        title="Providers"
        subtitle="API keys, models, and harness transports for the three QA agents."
        crumbs={
          <>
            <Link to="/settings">Settings</Link> / Providers
          </>
        }
      />
      <p className="body-secondary" style={{ margin: 0 }}>
        Save encrypts the credential with the OS keychain, persists it, and loads it into the host
        process immediately — it survives application restarts. Secret values are never displayed
        and never leave the desktop host process.
      </p>
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
      {statuses.isLoading ? <div className="skeleton">Loading provider status…</div> : null}
      <div className="cards">
        {AGENT_CARDS.map((card) => (
          <section className="card" key={card.title} aria-label={card.title + ' provider settings'}>
            <h2 className="section-title">{card.title}</h2>
            <p className="metadata" style={{ margin: '4px 0 12px' }}>
              {card.subtitle}
            </p>
            {card.fields.map((field) => (
              <CredentialField
                key={field.name}
                label={field.label}
                name={field.name}
                {...fieldProps}
              />
            ))}
          </section>
        ))}
      </div>
      <CollapsibleSection title="Advanced runtime binaries">
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
      </CollapsibleSection>
      <div className="card">
        <h2 className="section-title">Forget all provider credentials</h2>
        <p className="body-secondary">
          Removes every persisted secret and clears loaded values. Model preferences and unrelated
          app settings are preserved.
        </p>
        {confirmForget ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>Forget all credentials?</span>
            <button className="ghost" onClick={() => setConfirmForget(false)}>
              Keep
            </button>{' '}
            <button
              className="danger"
              onClick={() => forgetAll.mutate()}
              disabled={forgetAll.isPending}
            >
              Forget all
            </button>
          </div>
        ) : (
          <button className="danger" onClick={() => setConfirmForget(true)}>
            Forget all provider credentials
          </button>
        )}
      </div>
    </div>
  );
}

function CredentialField(props: {
  readonly label: string;
  readonly name: string;
  readonly values: Record<string, string>;
  readonly setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  readonly onSave: (name: string, value: string) => void;
  readonly onClear: (name: string) => void;
  readonly savePending: boolean;
  readonly clearPending: boolean;
  readonly byName: Map<string, ProviderStatus>;
}): React.JSX.Element {
  const item = props.byName.get(props.name);
  const secret = SECRET_NAMES.has(props.name);
  const current = props.values[props.name] ?? '';
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor={'provider-' + props.name} className="card-title">
          {props.label}
        </label>
        {item?.configured === true ? (
          <span className="metadata" title="Saved securely in OS keychain storage">
            <Check size={12} aria-hidden="true" /> Saved securely
          </span>
        ) : (
          <span className="metadata faint">Not set</span>
        )}
      </div>
      <div
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}
      >
        <input
          id={'provider-' + props.name}
          type={secret ? 'password' : 'text'}
          value={current}
          onChange={(e) => props.setValues((prev) => ({ ...prev, [props.name]: e.target.value }))}
          placeholder={
            secret
              ? '••••••••••'
              : item?.hint !== undefined && item.hint !== ''
                ? item.hint
                : 'Enter value'
          }
          aria-label={'Value for ' + props.name}
          autoComplete="off"
          spellCheck={false}
          style={{ minWidth: 200, flex: 1 }}
        />
        <button
          className="primary compact"
          disabled={current.trim().length === 0 || props.savePending}
          onClick={() => props.onSave(props.name, current)}
          title="Encrypt, persist, and load into the host process"
        >
          Save
        </button>
        <button
          className="compact ghost"
          disabled={item?.configured !== true || props.clearPending}
          onClick={() => props.onClear(props.name)}
        >
          Clear
        </button>
      </div>
      <details style={{ marginTop: 4 }}>
        <summary className="metadata">Advanced</summary>
        <p className="metadata mono" style={{ margin: '4px 0' }}>
          {props.name}
          {item !== undefined ? ' · ' + item.persistence + ' · ' + item.source : ''}
        </p>
        <p className="metadata" style={{ margin: 0 }}>
          {DESCRIPTIONS[props.name] ?? ''}
        </p>
      </details>
    </div>
  );
}

const BINARY_FIELDS = [
  { name: 'SENTRY_OPENCODE_BINARY', label: 'OpenCode executable' },
  { name: 'SENTRY_DEEPSEEK_BINARY', label: 'DeepSeek executable' },
  { name: 'SENTRY_GLM_BINARY', label: 'Claude Code executable' },
] as const;

export function HarnessBinaryCard(props: {
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
    <div className="card" style={{ marginBottom: 12, marginTop: 8 }}>
      <h3 className="card-title">Execution runtime</h3>
      <p className="body-secondary">
        Provider CLIs (opencode, dsh, Claude Code) execute inside the WSL2 Sentry runtime on Linux.
        Optional absolute Linux paths below override PATH lookup; leaving a field empty keeps
        automatic discovery. Paths refer to the selected WSL Linux runtime — Windows paths (C:… ) do
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
