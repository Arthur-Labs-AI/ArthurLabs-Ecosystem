import { OpenCodeHarnessError } from './errors.js';

/**
 * OpenCode model identifier composition.
 *
 * Sentry separates harness / provider / model; OpenCode's `--model` takes
 * one provider-qualified identifier (`provider/model`, split by OpenCode on
 * the FIRST `/`: providerID = head, modelID = rest). Composition:
 *
 * ```text
 * provider = "openrouter", model = "anthropic/claude-x"
 * => "openrouter/anthropic/claude-x"
 * ```
 *
 * Rules:
 * - provider: required, no `/`, no whitespace (lowercased for stability:
 *   OpenCode provider IDs are lowercase).
 * - model: required, no whitespace, no `://`, not leading/trailing `/`.
 * - If the model is already qualified with the same provider
 *   (`openrouter/anthropic/...`), it is used as-is: users must never
 *   produce `openrouter/openrouter/...` by configuring both fields.
 * - Any other form — bare (`gpt-4`) or vendor-qualified
 *   (`anthropic/claude-x`, the standard OpenRouter id shape) — is prefixed
 *   with the provider. OpenRouter vendor paths are model identity, not
 *   provider selection, so they are never rejected here.
 */

export interface OpenCodeModelIdentity {
  /** Configured provider id (e.g. `openrouter`). */
  readonly provider: string;
  /** Configured model id as entered (e.g. `anthropic/claude-x`). */
  readonly configuredModel: string;
  /** Effective `--model` identifier (e.g. `openrouter/anthropic/claude-x`). */
  readonly effectiveModelId: string;
}

function fail(message: string): never {
  throw new OpenCodeHarnessError('OPENCODE_MODEL_NOT_CONFIGURED', message);
}

/** Known built-in OpenCode upstream provider IDs supported by Sentry. */
export const KNOWN_OPENCODE_PROVIDERS: ReadonlySet<string> = new Set([
  'openrouter',
  'opencode',
  'opencode-go',
]);

function inferProviderFromModelPrefix(model: string | undefined): string | undefined {
  const configured = (model ?? '').trim();
  if (configured.length === 0 || !configured.includes('/')) return undefined;
  const head = (configured.split('/')[0] ?? '').toLowerCase();
  return KNOWN_OPENCODE_PROVIDERS.has(head) ? head : undefined;
}

export function normalizeOpenCodeProvider(provider: string | undefined, model?: string): string {
  const value = (provider ?? '').trim().toLowerCase();
  if (value.length === 0) {
    return inferProviderFromModelPrefix(model) ?? 'openrouter';
  }
  if (value.includes('/') || /\s/.test(value)) {
    throw new OpenCodeHarnessError(
      'OPENCODE_MODEL_NOT_CONFIGURED',
      'OpenCode provider must be a single identifier without slashes or whitespace.',
    );
  }
  return value;
}

export function buildOpenCodeModelId(
  provider: string | undefined,
  model: string | undefined,
): OpenCodeModelIdentity {
  const normalizedProvider = normalizeOpenCodeProvider(provider, model);
  const configuredModel = (model ?? '').trim();
  if (configuredModel.length === 0) {
    fail('OpenCode model is not configured. Set SENTRY_OPENCODE_MODEL to an exact model id.');
  }
  if (/\s/.test(configuredModel) || configuredModel.includes('://')) {
    fail('OpenCode model id is malformed: no whitespace or URL schemes allowed.');
  }
  if (configuredModel.startsWith('/') || configuredModel.endsWith('/')) {
    fail('OpenCode model id is malformed: leading/trailing slashes are not allowed.');
  }
  const head = configuredModel.split('/')[0] as string;
  if (head.toLowerCase() === normalizedProvider) {
    // Already qualified with the configured provider: use verbatim so the
    // effective id never doubles the prefix.
    return {
      provider: normalizedProvider,
      configuredModel,
      effectiveModelId: configuredModel,
    };
  }
  return {
    provider: normalizedProvider,
    configuredModel,
    effectiveModelId: normalizedProvider + '/' + configuredModel,
  };
}
