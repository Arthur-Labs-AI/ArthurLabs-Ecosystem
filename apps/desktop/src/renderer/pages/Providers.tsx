import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';
import {
  CUSTOM_MODEL_VALUE,
  DEEPSEEK_MODELS,
  LEGACY_DEEPSEEK_ALIASES,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
  ZAI_GLM_MODELS,
  modelsForOpenCodeMode,
  resolveOpenCodeBinarySuggestion,
  resolveOpenCodeModelMode,
  stripKnownOpenCodePrefix,
} from '../lib/provider-models.js';
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
  readonly modelList?: 'opencode' | 'deepseek' | 'glm';
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
        modelList: 'opencode',
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
        modelList: 'deepseek',
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
        modelList: 'glm',
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
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const environmentStacks = (
    environment.data as
      | { agentStacks?: Array<{ id?: string; executionPath?: string; binaryAvailable?: boolean }> }
      | undefined
  )?.agentStacks;
  const detectedOpenCodeBinary = (():
    { readonly path: string; readonly available: boolean } | undefined => {
    const stack = environmentStacks?.find((s) => s.id === 'stack_opencode_main');
    if (stack?.executionPath === undefined || stack.executionPath === '') return undefined;
    return { path: stack.executionPath, available: stack.binaryAvailable === true };
  })();
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
    onSuccess: (result, variables) => {
      // Clear only the saved field's draft: unrelated unsaved drafts stay intact.
      setValues((prev) => {
        if (!(variables as { name?: unknown } | undefined)?.name) return prev;
        const name = (variables as { name: string }).name;
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
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
            <Link to="/settings">Settings</Link> /{'Providers'}
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
            {card.title === 'OpenCode' ? (
              <OpenCodeCard {...fieldProps} />
            ) : (
              card.fields.map((field) =>
                field.modelList === undefined ? (
                  <CredentialField
                    key={field.name}
                    label={field.label}
                    name={field.name}
                    placeholder={field.placeholder}
                    detailsLabel={field.detailsLabel}
                    {...fieldProps}
                  />
                ) : (
                  <ModelSelectField
                    key={field.name}
                    label={field.label}
                    name={field.name}
                    placeholder={field.placeholder ?? 'Select a model…'}
                    detailsLabel={field.detailsLabel}
                    description={DESCRIPTIONS[field.name]}
                    options={
                      field.modelList === 'deepseek'
                        ? DEEPSEEK_MODELS
                        : field.modelList === 'glm'
                          ? ZAI_GLM_MODELS
                          : OPENCODE_GO_MODELS
                    }
                    optionNote={field.modelList === 'deepseek' ? deepSeekOptionNote : undefined}
                    {...fieldProps}
                  />
                ),
              )
            )}
          </section>
        ))}
      </div>
      <CollapsibleSection title="Advanced runtime binaries">
        <HarnessBinaryCard
          statuses={statuses.isError ? [] : (statuses.data ?? [])}
          statusPending={statuses.isLoading}
          detectedOpenCodeBinary={detectedOpenCodeBinary}
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
  readonly listId?: string | undefined;
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
          list={props.listId}
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

function resolveEffectiveOpenCodeProvider(
  values: Record<string, string>,
  byName: Map<string, ProviderStatus>,
): string {
  const draft = (values['SENTRY_OPENCODE_PROVIDER'] ?? '').trim().toLowerCase();
  if (draft !== '') return draft;
  return inferOpenCodeProvider(
    byName.get('SENTRY_OPENCODE_PROVIDER'),
    byName.get('SENTRY_OPENCODE_MODEL'),
  ).provider;
}

interface ModelFieldProps {
  readonly label: string;
  readonly name: string;
  readonly options: ReadonlyArray<string>;
  readonly setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  readonly onSave: (name: string, value: string) => void;
  readonly onClear: (name: string) => void;
  readonly savePending: boolean;
  readonly clearPending: boolean;
  readonly byName: Map<string, ProviderStatus>;
  readonly statusPending: boolean;
  readonly placeholder: string;
  readonly values: Record<string, string>;
  readonly detailsLabel?: string | null | undefined;
  readonly description?: string | undefined;
  readonly optionNote?: ((id: string) => string | undefined) | undefined;
}
function modelFieldValue(
  values: Record<string, string>,
  name: string,
  hint: string | undefined,
): string {
  const draft = values[name] ?? '';
  if (draft !== '') return draft;
  return hint ?? '';
}
function deepSeekOptionNote(id: string): string | undefined {
  return LEGACY_DEEPSEEK_ALIASES.includes(id) ? 'legacy alias of deepseek-flash' : undefined;
}
/**
 * Model dropdown with a custom-id escape hatch. The saved value is never
 * rewritten here: unknown (provider-prefixed, legacy, or custom) ids stay
 * visible with a warning, and Save stays disabled until there is a value.
 */
function ModelSelectField(props: ModelFieldProps): React.JSX.Element {
  const item = props.byName.get(props.name);
  const activeHint = item?.configured === true && item.hint !== '' ? item.hint : undefined;
  const draft = props.values[props.name] ?? '';
  const current = modelFieldValue(props.values, props.name, activeHint);
  const trimmed = current.trim();
  const stripped = stripKnownOpenCodePrefix(trimmed);
  const known =
    trimmed === '' || props.options.includes(trimmed) || props.options.includes(stripped);
  const selectedOption = props.options.includes(trimmed)
    ? trimmed
    : stripped !== trimmed && props.options.includes(stripped)
      ? stripped
      : '';
  const [customMode, setCustomMode] = React.useState(false);
  const showCustom = customMode || (!known && trimmed !== '');
  const selectValue =
    known && selectedOption !== '' ? selectedOption : customMode ? CUSTOM_MODEL_VALUE : '';
  const saveValue = current.trim();
  const onSelect = (raw: string): void => {
    if (raw === CUSTOM_MODEL_VALUE) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    props.setValues((prev) => ({ ...prev, [props.name]: raw }));
  };
  const selectedNote = selectedOption !== '' ? props.optionNote?.(selectedOption) : undefined;
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
        </span>
      </div>
      <div
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}
      >
        <select
          id={'provider-' + props.name}
          aria-label={'Value for ' + props.name}
          value={selectValue}
          onChange={(e) => onSelect(e.target.value)}
          style={{ minWidth: 200, flex: 1 }}
        >
          <option value="">Select a model…</option>
          {props.options.map((id) => {
            const note = props.optionNote?.(id);
            return (
              <option key={id} value={id}>
                {note === undefined ? id : id + ' (' + note + ')'}
              </option>
            );
          })}
          <option value={CUSTOM_MODEL_VALUE}>Custom model id…</option>
        </select>
        <button
          className="primary compact"
          disabled={saveValue === '' || props.savePending}
          onClick={() => props.onSave(props.name, saveValue)}
          title="Persist and load into the host process"
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
      {showCustom ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            id={'provider-' + props.name + '-custom'}
            type="text"
            value={draft !== '' ? draft : (activeHint ?? '')}
            onChange={(e) => props.setValues((prev) => ({ ...prev, [props.name]: e.target.value }))}
            placeholder={props.placeholder}
            aria-label={'Custom value for ' + props.name}
            autoComplete="off"
            spellCheck={false}
            style={{ minWidth: 200, flex: 1 }}
          />
        </div>
      ) : null}
      {!known && trimmed !== '' ? (
        <p className="metadata" style={{ margin: '4px 0 0' }}>
          {`Saved model “${trimmed}” is not in the current list. It is preserved — select a listed model above or keep this custom id.`}
        </p>
      ) : null}
      {selectedNote !== undefined && known && selectedOption !== '' ? (
        <p className="metadata" style={{ margin: '4px 0 0' }}>
          {`${selectedOption} is a ${selectedNote}. Your saved value is preserved.`}
        </p>
      ) : null}
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
            {props.description ?? ''}
          </p>
        </details>
      ) : null}
    </div>
  );
}

const VALID_OPENCODE_PROVIDERS: readonly string[] = ['opencode-go', 'opencode', 'openrouter'];

const OPENCODE_PROVIDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  {
    value: 'opencode-go',
    label: 'OpenCode Go / Go Plus — monthly subscription (uses the OpenCode API key)',
  },
  { value: 'opencode', label: 'OpenCode Zen — pay-as-you-go (uses the OpenCode API key)' },
  { value: 'openrouter', label: 'OpenRouter — pay-as-you-go (uses the OpenRouter API key)' },
];

/**
 * Remember the last explicit Go-vs-Zen choice so switching the credential
 * source back to the OpenCode key restores it instead of leaving Provider
 * unset. Draft wins, then the persisted explicit value, then a model-prefix
 * hint, then the explicit 'opencode-go' fallback (always visible and
 * correctable in the Provider select — never applied silently elsewhere).
 */
function lastExplicitGoZenChoice(
  values: Record<string, string>,
  byName: Map<string, ProviderStatus>,
  remembered: string | null,
): string {
  const draft = (values['SENTRY_OPENCODE_PROVIDER'] ?? '').trim().toLowerCase();
  if (draft === 'opencode-go' || draft === 'opencode') return draft;
  const persisted = byName.get('SENTRY_OPENCODE_PROVIDER');
  const persistedValue = persisted?.configured === true ? persisted.hint.trim().toLowerCase() : '';
  if (persistedValue === 'opencode-go' || persistedValue === 'opencode') return persistedValue;
  if (remembered === 'opencode-go' || remembered === 'opencode') return remembered;
  const model = byName.get('SENTRY_OPENCODE_MODEL');
  const prefix =
    model?.configured === true && model.hint.includes('/')
      ? (model.hint.split('/')[0] ?? '').toLowerCase()
      : '';
  if (prefix === 'opencode-go' || prefix === 'opencode') return prefix;
  return 'opencode-go';
}

/**
 * Segmented credential-source selector, shown only when both keys are
 * configured (presence from status metadata — secrets never reach the
 * renderer). Switching saves only SENTRY_OPENCODE_PROVIDER; both keys stay
 * securely stored.
 */
function CredentialSourceSelector(props: {
  readonly values: Record<string, string>;
  readonly byName: Map<string, ProviderStatus>;
  readonly onSave: (name: string, value: string) => void;
  readonly savePending: boolean;
  readonly rememberedGoZen: string | null;
}): React.JSX.Element | null {
  const openCodeKey = props.byName.get('OPENCODE_API_KEY');
  const openRouterKey = props.byName.get('OPENROUTER_API_KEY');
  if (openCodeKey?.configured !== true || openRouterKey?.configured !== true) return null;
  const draft = (props.values['SENTRY_OPENCODE_PROVIDER'] ?? '').trim().toLowerCase();
  const persisted = props.byName.get('SENTRY_OPENCODE_PROVIDER');
  const persistedValue = persisted?.configured === true ? persisted.hint.trim().toLowerCase() : '';
  const active = draft !== '' ? draft : persistedValue;
  const usingOpenRouter = active === '' || active === 'openrouter';
  return (
    <div style={{ marginBottom: 12 }}>
      <span id="credential-source-label" className="card-title">
        Credential source
      </span>
      <div
        role="group"
        aria-labelledby="credential-source-label"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}
      >
        <button
          className={usingOpenRouter ? 'compact ghost' : 'primary compact'}
          aria-pressed={!usingOpenRouter}
          disabled={props.savePending}
          onClick={() =>
            props.onSave(
              'SENTRY_OPENCODE_PROVIDER',
              lastExplicitGoZenChoice(props.values, props.byName, props.rememberedGoZen),
            )
          }
        >
          Use OpenCode key
        </button>
        <button
          className={usingOpenRouter ? 'primary compact' : 'compact ghost'}
          aria-pressed={usingOpenRouter}
          disabled={props.savePending}
          onClick={() => props.onSave('SENTRY_OPENCODE_PROVIDER', 'openrouter')}
        >
          Use OpenRouter key
        </button>
      </div>
      <p className="metadata" style={{ margin: '4px 0 0' }}>
        Both keys are stored securely. Switching only changes which key Sentry uses; the other key
        stays saved.
      </p>
    </div>
  );
}

/**
 * OpenCode card: selectable provider, mode-aware model control (Go / Go Plus
 * dropdown from the official Go docs; Zen and OpenRouter use a manual model
 * text input), credential-source selector, and the two key fields. The
 * "Active upstream" line reflects persisted status only, so a failed save
 * never presents a draft as activated.
 */
function OpenCodeCard(props: {
  readonly values: Record<string, string>;
  readonly setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  readonly onSave: (name: string, value: string) => void;
  readonly onClear: (name: string) => void;
  readonly savePending: boolean;
  readonly clearPending: boolean;
  readonly byName: Map<string, ProviderStatus>;
  readonly statusPending: boolean;
}): React.JSX.Element {
  const providerStatus = props.byName.get('SENTRY_OPENCODE_PROVIDER');
  const modelStatus = props.byName.get('SENTRY_OPENCODE_MODEL');
  const persistedProvider =
    providerStatus?.configured === true ? providerStatus.hint.trim().toLowerCase() : '';
  const draftRaw = props.values['SENTRY_OPENCODE_PROVIDER'];
  const hasDraft = draftRaw !== undefined && draftRaw.trim() !== '';
  const effectiveProvider = resolveEffectiveOpenCodeProvider(props.values, props.byName);
  const mode = resolveOpenCodeModelMode(effectiveProvider === '' ? undefined : effectiveProvider);
  const selectValue = hasDraft ? (draftRaw as string) : persistedProvider;
  const persistedKnown =
    persistedProvider === '' || VALID_OPENCODE_PROVIDERS.includes(persistedProvider);
  const draftValid =
    hasDraft && VALID_OPENCODE_PROVIDERS.includes((draftRaw as string).trim().toLowerCase());
  const activeModel =
    modelStatus?.configured === true && modelStatus.hint !== '' ? modelStatus.hint : undefined;
  const hasPersistedState = providerStatus !== undefined || modelStatus !== undefined;
  // Session memory of the last explicit Go-vs-Zen choice, so switching the
  // credential source back to the OpenCode key restores it after the
  // persisted provider has moved to openrouter.
  const [rememberedGoZen, setRememberedGoZen] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (persistedProvider === 'opencode-go' || persistedProvider === 'opencode') {
      setRememberedGoZen(persistedProvider);
    }
  }, [persistedProvider]);
  const common = {
    values: props.values,
    setValues: props.setValues,
    onSave: props.onSave,
    onClear: props.onClear,
    savePending: props.savePending,
    clearPending: props.clearPending,
    byName: props.byName,
    statusPending: props.statusPending,
  };
  return (
    <div>
      {hasPersistedState ? (
        <p className="metadata" style={{ margin: '0 0 12px' }}>
          {`Active upstream: ${persistedProvider === '' ? 'openrouter (default)' : persistedProvider}${activeModel !== undefined ? ' · ' + activeModel : ' · no model saved'}`}
        </p>
      ) : null}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="provider-SENTRY_OPENCODE_PROVIDER" className="card-title">
            Provider
          </label>
          <span className={providerStatus?.configured ? 'metadata' : 'metadata faint'}>
            {providerStatus?.configured ? <Check size={12} aria-hidden="true" /> : null}
            {providerStatus === undefined
              ? props.statusPending
                ? 'Checking…'
                : 'Status unavailable'
              : providerStatus.source === 'environment'
                ? 'From environment'
                : providerStatus.configured
                  ? 'Saved preference'
                  : providerStatus.source === 'missing'
                    ? 'Not set'
                    : 'Status unavailable'}
          </span>
        </div>
        <div
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}
        >
          <select
            id="provider-SENTRY_OPENCODE_PROVIDER"
            aria-label="Value for SENTRY_OPENCODE_PROVIDER"
            value={selectValue}
            onChange={(e) =>
              props.setValues((prev) => ({
                ...prev,
                SENTRY_OPENCODE_PROVIDER: e.target.value,
              }))
            }
            style={{ minWidth: 200, flex: 1 }}
          >
            <option value="">Not set (defaults to OpenRouter pay-as-you-go)</option>
            {OPENCODE_PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!persistedKnown && !hasDraft ? (
              <option value={persistedProvider}>
                {`Keep saved “${persistedProvider}” (unrecognized)`}
              </option>
            ) : null}
          </select>
          <button
            className="primary compact"
            disabled={!hasDraft || !draftValid || props.savePending}
            onClick={() => props.onSave('SENTRY_OPENCODE_PROVIDER', (draftRaw as string).trim())}
            title="Persist and load into the host process"
          >
            Save
          </button>
          <button
            className="compact ghost"
            disabled={providerStatus?.configured !== true || props.clearPending}
            onClick={() => props.onClear('SENTRY_OPENCODE_PROVIDER')}
          >
            Clear
          </button>
        </div>
        {!persistedKnown && !hasDraft ? (
          <p className="metadata" style={{ margin: '4px 0 0' }}>
            {`Saved provider “${persistedProvider}” is unrecognized. It is preserved — select a supported provider above before saving.`}
          </p>
        ) : null}
      </div>
      {mode === 'go' ? (
        <ModelSelectField
          label="Model"
          name="SENTRY_OPENCODE_MODEL"
          placeholder="e.g. kimi-k3"
          detailsLabel={null}
          description={DESCRIPTIONS['SENTRY_OPENCODE_MODEL']}
          options={modelsForOpenCodeMode('go')}
          {...common}
        />
      ) : (
        <CredentialField
          label="Model"
          name="SENTRY_OPENCODE_MODEL"
          placeholder={
            mode === 'zen'
              ? 'e.g. gpt-5.5, claude-opus-4-6, or kimi-k3'
              : 'e.g. anthropic/claude-sonnet-4'
          }
          detailsLabel={null}
          listId={mode === 'zen' ? 'opencode-zen-model-suggestions' : undefined}
          {...common}
        />
      )}
      {mode === 'zen' ? (
        <datalist id="opencode-zen-model-suggestions">
          {OPENCODE_ZEN_MODELS.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      ) : null}
      <CredentialSourceSelector
        values={props.values}
        byName={props.byName}
        onSave={props.onSave}
        savePending={props.savePending}
        rememberedGoZen={rememberedGoZen}
      />
      <CredentialField
        label="OpenCode API key (Zen & Go)"
        name="OPENCODE_API_KEY"
        detailsLabel="Explanation"
        {...common}
      />
      <CredentialField
        label="OpenRouter API key (Pay-as-you-go)"
        name="OPENROUTER_API_KEY"
        detailsLabel="Explanation"
        {...common}
      />
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
  /** Live-detected OpenCode executable from the runtime doctors (optional). */
  readonly detectedOpenCodeBinary?:
    { readonly path: string; readonly available: boolean } | undefined;
}): React.JSX.Element {
  const looksWindowsPath = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value.trim());
  // OpenCode path suggestion: live runtime detection first (only when the
  // binary is actually available), sibling-home heuristic as fallback.
  const openCodeSuggestion = resolveOpenCodeBinarySuggestion(
    props.detectedOpenCodeBinary,
    props.statuses,
  );
  const openCodeDraft = props.values['SENTRY_OPENCODE_BINARY'] ?? '';
  const openCodeSaved = props.statuses.find((s) => s.name === 'SENTRY_OPENCODE_BINARY');
  const autoFilledRef = React.useRef(false);
  React.useEffect(() => {
    if (openCodeSuggestion === undefined || autoFilledRef.current) return;
    if (openCodeDraft !== '' || openCodeSaved?.configured === true) return;
    autoFilledRef.current = true;
    const path = openCodeSuggestion.path;
    props.setValues((prev) => ({ ...prev, ['SENTRY_OPENCODE_BINARY']: path }));
  }, [openCodeSuggestion, openCodeDraft, openCodeSaved?.configured === true, props.setValues]);
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
        const suggestion = field.name === 'SENTRY_OPENCODE_BINARY' ? openCodeSuggestion : undefined;
        const showSuggestion = suggestion !== undefined && current.trim() !== suggestion.path;
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
            {suggestion !== undefined ? (
              <p className="metadata" style={{ margin: '4px 0 0' }}>
                {suggestion.source === 'detected'
                  ? 'Suggested OpenCode path from runtime detection.'
                  : 'Suggested OpenCode path derived from your other executable settings.'}
              </p>
            ) : null}
            {showSuggestion && suggestion !== undefined ? (
              <div style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="compact ghost"
                  onClick={() =>
                    props.setValues((prev) => ({ ...prev, [field.name]: suggestion.path }))
                  }
                >
                  Use suggested path
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
