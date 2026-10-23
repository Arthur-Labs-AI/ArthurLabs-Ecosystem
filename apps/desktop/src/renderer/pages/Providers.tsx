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
  storageError?: string;
}

const DESCRIPTIONS: Record<string, string> = {
  OPENROUTER_API_KEY:
    'OpenRouter pay-as-you-go provider key (secret, from openrouter.ai). Used by the OpenCode harness only when Provider is openrouter (or left unset). Never shown, never leaves the desktop host process except over the encrypted runtime channel.',
  SENTRY_OPENCODE_MODEL:
    'OpenCode model id (non-secret) for the selected provider — e.g. kimi-k3 or gemini-4-argon-contributor (opencode-go), gpt-5.5 (opencode), or anthropic/claude-opus-4-6 (openrouter). Prefixing with opencode-go/, opencode/, or openrouter/ also selects that provider when Provider is unset.',
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
    'OpenCode Console provider key (secret, from opencode.ai/console). Used for both OpenCode Go monthly subscriptions (Provider: opencode-go) and OpenCode Zen pay-as-you-go credits (Provider: opencode).',
  SENTRY_OPENCODE_PROVIDER:
    'OpenCode upstream provider (non-secret): opencode-go (OpenCode Go monthly subscription gateway), opencode (OpenCode Zen pay-as-you-go Console gateway), or openrouter (OpenRouter pay-as-you-go gateway; default when unset).',
};

const SECRET_NAMES: ReadonlySet<string> = new Set([
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

interface AgentFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly detailsLabel?: string | null;
}

interface AgentCardSpec {
  readonly title: string;
  readonly subtitle: string;
  readonly fields: ReadonlyArray<AgentFieldSpec>;
}

const AGENT_CARDS: readonly AgentCardSpec[] = [
  {
    title: 'OpenCode',
    subtitle:
      'Primary coding agent · OpenCode Go (subscription), OpenCode Zen (pay-as-you-go), or OpenRouter',
    fields: [
      {
        name: 'SENTRY_OPENCODE_PROVIDER',
        label: 'Provider',
        placeholder: 'opencode-go, opencode, or openrouter',
        detailsLabel: null,
      },
      {
        name: 'SENTRY_OPENCODE_MODEL',
        label: 'Model',
        placeholder: 'e.g. kimi-k3, gpt-5.5, or anthropic/claude-sonnet-4',
        detailsLabel: null,
      },
      {
        name: 'OPENCODE_API_KEY',
        label: 'OpenCode API key (Zen & Go)',
        detailsLabel: 'Explanation',
      },
      {
        name: 'OPENROUTER_API_KEY',
        label: 'OpenRouter API key (Pay-as-you-go)',
        detailsLabel: 'Explanation',
      },
    ],
  },
  {
    title: 'DeepSeek',
    subtitle: 'Second reviewer · DeepSeek API',
    fields: [
      {
        name: 'SENTRY_DEEPSEEK_MODEL',
        label: 'Model',
        placeholder: 'e.g. deepseek-v4-flash',
      },
      { name: 'DEEPSEEK_API_KEY', label: 'API key' },
    ],
  },
  {
    title: 'GLM',
    subtitle: 'Third reviewer · Claude Code harness on Z.AI endpoint',
    fields: [
      {
        name: 'SENTRY_GLM_MODEL',
        label: 'Model',
        placeholder: 'e.g. glm-5.3-flash',
      },
      {
        name: 'ANTHROPIC_BASE_URL',
        label: 'Endpoint',
        placeholder: 'https://api.z.ai/api/anthropic',
      },
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
    queryFn: async () => {
      const result = await sentryApi().providers.status();
      if (
        !Array.isArray(result) ||
        result.some(
          (item) =>
            item === null ||
            typeof item !== 'object' ||
            typeof item.name !== 'string' ||
            typeof item.configured !== 'boolean' ||
            typeof item.source !== 'string' ||
            typeof item.persistence !== 'string' ||
            typeof item.hint !== 'string',
        )
      )
        throw new Error('Provider status unavailable');
      return result as ProviderStatus[];
    },
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['environment'] });
    void queryClient.invalidateQueries({ queryKey: ['production-readiness'] });
  };
  const fail = (e: unknown): void => {
    setNote(undefined);
    setError(e instanceof Error ? e.message : String(e));
  };
  const save = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      sentryApi().providers.save(name, value),
    onMutate: () => {
      setNote(undefined);
      setError(undefined);
    },
    onSuccess: (result) => {
      setValues({});
      setError(undefined);
      const status = result as ProviderStatus;
      setNote(
        status?.configured && status.persistence === 'secure' && status.source === 'stored'
          ? 'Saved. Stored securely and loaded into the desktop host process.'
          : status?.persistence === 'persisted'
            ? 'Saved preference and loaded into the desktop host process.'
            : 'Save completed. Refreshing provider status.',
      );
      refresh();
    },
    onError: (e) => {
      fail(e);
      refresh();
    },
  });
  const clear = useMutation({
    onMutate: () => {
      setNote(undefined);
      setError(undefined);
    },
    mutationFn: (name: string) => sentryApi().providers.clearKey(name),
    onSuccess: () => {
      setError(undefined);
      refresh();
    },
    onError: fail,
  });
  const forgetAll = useMutation({
    onMutate: () => {
      setNote(undefined);
      setError(undefined);
    },
    mutationFn: () => sentryApi().providers.forgetAll(),
    onSuccess: () => {
      setConfirmForget(false);
      setNote('All provider credentials forgotten. App preferences were preserved.');
      refresh();
    },
    onError: fail,
  });
  const byName = new Map(
    (statuses.isError ? [] : (statuses.data ?? [])).map((item) => [item.name, item]),
  );
  const fieldProps = {
    values,
    setValues,
    onSave: (name: string, value: string) => save.mutate({ name, value }),
    onClear: (name: string) => clear.mutate(name),
    savePending: save.isPending,
    clearPending: clear.isPending,
    byName,
    statusPending: statuses.isLoading,
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
      {statuses.isError ? (
        <div className="error-box" role="alert">
          Provider status unavailable. Credential presence could not be checked.{' '}
          <button
            className="compact ghost"
            onClick={() => {
              void statuses.refetch();
            }}
            disabled={statuses.isFetching}
          >
            Retry provider status
          </button>
        </div>
      ) : null}
      <div className="cards">
        {AGENT_CARDS.map((card) => (
          <section className="card" key={card.title} aria-label={card.title + ' provider settings'}>
            <h2 className="section-title">{card.title}</h2>
            <p className="metadata" style={{ margin: '4px 0 12px' }}>
              {card.subtitle}
            </p>
            {card.title === 'OpenCode' ? <OpenCodeProviderGuidance byName={byName} /> : null}
            {card.fields.map((field) => (
              <CredentialField
                key={field.name}
                label={field.label}
                name={field.name}
                placeholder={field.placeholder}
                detailsLabel={field.detailsLabel}
                {...fieldProps}
              />
            ))}
          </section>
        ))}
      </div>
      <CollapsibleSection title="Advanced runtime binaries">
        <HarnessBinaryCard
          statuses={statuses.isError ? [] : (statuses.data ?? [])}
          statusPending={statuses.isLoading}
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

function inferOpenCodeProvider(
  providerStatus: ProviderStatus | undefined,
  modelStatus: ProviderStatus | undefined,
): { readonly provider: string; readonly explicit: boolean } {
  const explicitProvider =
    providerStatus?.configured === true ? providerStatus.hint.trim().toLowerCase() : '';
  if (explicitProvider.length > 0) {
    return { provider: explicitProvider, explicit: true };
  }
  const configuredModel = modelStatus?.configured === true ? modelStatus.hint.trim() : '';
  const head = configuredModel.includes('/')
    ? (configuredModel.split('/')[0] ?? '').toLowerCase()
    : '';
  if (head === 'opencode-go' || head === 'opencode' || head === 'openrouter') {
    return { provider: head, explicit: true };
  }
  return { provider: 'openrouter', explicit: false };
}

function OpenCodeProviderGuidance(props: {
  readonly byName: Map<string, ProviderStatus>;
}): React.JSX.Element | null {
  const providerStatus = props.byName.get('SENTRY_OPENCODE_PROVIDER');
  const modelStatus = props.byName.get('SENTRY_OPENCODE_MODEL');
  const openCodeKey = props.byName.get('OPENCODE_API_KEY');
  const openRouterKey = props.byName.get('OPENROUTER_API_KEY');
  if (
    providerStatus === undefined &&
    modelStatus === undefined &&
    openCodeKey === undefined &&
    openRouterKey === undefined
  ) {
    return null;
  }
  const { provider, explicit } = inferOpenCodeProvider(providerStatus, modelStatus);
  const hasOpenCodeKey = openCodeKey?.configured === true;
  const hasOpenRouterKey = openRouterKey?.configured === true;

  if (!explicit && hasOpenCodeKey && !hasOpenRouterKey) {
    return (
      <div className="inline-notice" style={{ marginBottom: 12 }}>
        <strong>Provider selection needed:</strong> You saved an{' '}
        <strong>OpenCode API key (Zen &amp; Go)</strong>, while <strong>Provider</strong> is unset
        (defaults to <code>openrouter</code>). Save <code>opencode-go</code> (for an OpenCode Go
        subscription) or <code>opencode</code> (for OpenCode Zen pay-as-you-go) in{' '}
        <strong>Provider</strong> so Sentry uses your OpenCode key.
      </div>
    );
  }
  if (
    (provider === 'opencode-go' || provider === 'opencode') &&
    !hasOpenCodeKey &&
    hasOpenRouterKey
  ) {
    return (
      <div className="inline-notice" style={{ marginBottom: 12 }}>
        <strong>Key field mismatch:</strong> <strong>Provider</strong> is set to{' '}
        <code>{provider}</code>, which uses the <strong>OpenCode API key (Zen &amp; Go)</strong>{' '}
        field. The <strong>OpenRouter API key (Pay-as-you-go)</strong> field is only used when{' '}
        <strong>Provider</strong> is <code>openrouter</code>.
      </div>
    );
  }
  return null;
}

function CredentialField(props: {
  readonly label: string;
  readonly name: string;
  readonly placeholder?: string | undefined;
  readonly detailsLabel?: string | null | undefined;
  readonly values: Record<string, string>;
  readonly setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  readonly onSave: (name: string, value: string) => void;
  readonly onClear: (name: string) => void;
  readonly savePending: boolean;
  readonly clearPending: boolean;
  readonly byName: Map<string, ProviderStatus>;
  readonly statusPending: boolean;
}): React.JSX.Element {
  const item = props.byName.get(props.name);
  const secret = SECRET_NAMES.has(props.name);
  const current = props.values[props.name] ?? '';
  const activeHint =
    !secret && item?.configured === true && item.hint !== '' ? item.hint : undefined;
  const disclosureLabel = props.detailsLabel === undefined ? 'Advanced' : props.detailsLabel;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label htmlFor={'provider-' + props.name} className="card-title">
          {props.label}
        </label>
        <span className={item?.configured ? 'metadata' : 'metadata faint'}>
          {item?.configured && item.source !== 'unavailable' ? (
            <Check size={12} aria-hidden="true" />
          ) : null}
          {item === undefined
            ? props.statusPending
              ? 'Checking…'
              : 'Status unavailable'
            : item.source === 'unavailable'
              ? 'Stored credential unavailable'
              : item.source === 'environment'
                ? 'From environment'
                : item.configured && item.source === 'stored' && item.persistence === 'secure'
                  ? 'Stored securely'
                  : item.configured && item.source === 'persisted'
                    ? 'Saved preference'
                    : item.source === 'missing' && !item.configured
                      ? 'Not set'
                      : 'Status unavailable'}
          {activeHint !== undefined ? ' · ' + activeHint : ''}
        </span>
      </div>
      <div
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}
      >
        <input
          id={'provider-' + props.name}
          type={secret ? 'password' : 'text'}
          value={current}
          onChange={(e) => props.setValues((prev) => ({ ...prev, [props.name]: e.target.value }))}
          placeholder={secret ? '••••••••••' : (activeHint ?? props.placeholder ?? 'Enter value')}
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
          disabled={
            (item?.configured !== true && item?.source !== 'unavailable') || props.clearPending
          }
          onClick={() => props.onClear(props.name)}
        >
          Clear
        </button>
      </div>
      {item?.storageError !== undefined ? (
        <p className="metadata">
          Stored credential unavailable. Check OS secure storage; keep the existing store.
        </p>
      ) : null}
      {disclosureLabel !== null ? (
        <details style={{ marginTop: 4 }}>
          <summary className="metadata">{disclosureLabel}</summary>
          <p className="metadata mono" style={{ margin: '4px 0' }}>
            {props.name}
            {item !== undefined ? ' · ' + item.persistence + ' · ' + item.source : ''}
          </p>
          <p className="metadata" style={{ margin: 0 }}>
            {DESCRIPTIONS[props.name] ?? ''}
          </p>
        </details>
      ) : null}
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
  readonly statusPending?: boolean;
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
              (
              {status === undefined
                ? props.statusPending
                  ? 'Checking…'
                  : 'Status unavailable'
                : status.configured
                  ? status.source === 'environment'
                    ? 'From environment'
                    : 'Saved preference'
                  : status.source === 'missing'
                    ? 'Not set'
                    : 'Status unavailable'}
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
