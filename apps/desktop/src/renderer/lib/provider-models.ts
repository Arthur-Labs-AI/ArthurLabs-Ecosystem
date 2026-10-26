/**
 * Model catalogs for the Settings / Providers page.
 *
 * Sources (verified 2026-10-25; ids are exact API model ids):
 * - OpenCode Go (Go and Go Plus share this published list): the "Model ID"
 *   table at https://opencode.ai/docs/go/ (used as `opencode-go/<model-id>`).
 * - OpenCode Zen pay-as-you-go: the "Model ID" table at
 *   https://opencode.ai/docs/zen/ (free-tier `*-free` entries excluded).
 *   Zen modes use a manual model text input in the UI; this catalog is the
 *   documented reference, not a dropdown.
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing/ — current
 *   recommendations are `deepseek-flash` and `deepseek-v4-pro`;
 *   `deepseek-v4-flash` is a legacy alias of `deepseek-flash` (see
 *   packages/harness-deepseek/src/discovery.ts) and is listed last so the UI
 *   can label it as legacy instead of a separate current model.
 * - Z.AI GLM for the Claude Code harness on the Anthropic-compatible
 *   endpoint https://api.z.ai/api/anthropic:
 *   https://docs.z.ai/devpack/latest-model.md (glm-5.3-flash / glm-5.3, with
 *   optional `[1m]` suffix for 1M context) and the GLM-5.x coding lineup in
 *   https://docs.z.ai/guides/overview/pricing.md.
 *
 * Catalogs are data only: saving always writes the exact id the user chose,
 * and unknown (provider-prefixed, legacy, or custom) saved values are
 * preserved verbatim — never silently replaced.
 */

/** Sentinel select value for "enter a custom model id" (not a real model). */
export const CUSTOM_MODEL_VALUE = '__custom-model__';

/**
 * Conventional managed OpenCode executable inside the Linux runtime, given
 * the WSL home directory (e.g. `/home/merte`). Matches the managed install
 * layout provisioned under `~/.local/share/sentry/tools`.
 */
export const MANAGED_OPENCODE_BINARY_SUFFIX =
  '/.local/share/sentry/tools/opencode/node_modules/.bin/opencode';

/** Minimal status shape needed to derive a managed-binary suggestion. */
export interface BinaryStatusHint {
  readonly name: string;
  readonly configured: boolean;
  readonly hint: string;
}

const SIBLING_BINARY_NAMES: readonly string[] = ['SENTRY_DEEPSEEK_BINARY', 'SENTRY_GLM_BINARY'];

/** Extract `/home/<user>` from a saved absolute Linux path, if present. */
function wslHomePrefix(value: string): string | undefined {
  const match = /^\/home\/[^/\s]+/.exec(value.trim());
  return match === null ? undefined : match[0];
}

/**
 * Suggest the managed OpenCode executable path by reusing the WSL home
 * directory from a sibling saved executable setting (DeepSeek, then GLM).
 * Only the username is taken from the sibling — the rest is the fixed
 * managed-install layout, never the sibling's own path. Returns undefined
 * when no sibling carries a usable `/home/<user>` prefix.
 */
export function suggestManagedOpenCodeBinary(
  statuses: ReadonlyArray<BinaryStatusHint>,
): { readonly path: string; readonly from: string } | undefined {
  for (const name of SIBLING_BINARY_NAMES) {
    const status = statuses.find((s) => s.name === name);
    const hint = status?.configured === true ? status.hint.trim() : '';
    if (hint === '' || hint === 'missing') continue;
    const home = wslHomePrefix(hint);
    if (home === undefined) continue;
    return { path: home + MANAGED_OPENCODE_BINARY_SUFFIX, from: name };
  }
  return undefined;
}

/**
 * OpenCode Go / Go Plus subscription lineup (29 ids, official Go docs).
 * Go and Go Plus share this published list: do not invent separate catalogs.
 */
export const OPENCODE_GO_MODELS: readonly string[] = [
  'grok-4.7',
  'gpt-6-luna',
  'gpt-5.6-luna',
  'claude-haiku-5-5',
  'gemini-4-argon',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'kimi-k3.1-pro',
  'kimi-k3',
  'kimi-k2.7-code',
  'longcat-2.0',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m3.1-flash',
  'minimax-m3',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-plus',
  'hy4-preview',
  'hy3',
  'step-5-preview',
  'beam-free',
];

/**
 * OpenCode Zen pay-as-you-go lineup (official Zen docs, free-tier entries
 * excluded). Reference only: Zen modes use a manual model text input.
 */
export const OPENCODE_ZEN_MODELS: readonly string[] = [
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-nano',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-build-0.1',
  'muse-wonder-1.0',
  'muse-spark-1.3',
  'muse-spark-1.2',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'kimi-k2.5',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
  'big-pickle',
  'jev-1.13',
  'mistral-large-4',
];

/**
 * Current DeepSeek API models first; the legacy `deepseek-v4-flash` alias
 * is kept last so the UI preserves it without presenting it as current.
 */
export const DEEPSEEK_MODELS: readonly string[] = [
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
];

/** DeepSeek ids that are legacy aliases rather than current models. */
export const LEGACY_DEEPSEEK_ALIASES: readonly string[] = ['deepseek-v4-flash'];

/** Current Z.AI GLM coding lineup for the Anthropic-compatible endpoint. */
export const ZAI_GLM_MODELS: readonly string[] = [
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
];

/** Provider prefixes that may qualify a saved OpenCode model id. */
const KNOWN_OPENCODE_PREFIXES: readonly string[] = ['opencode-go', 'opencode', 'openrouter'];

/**
 * Strip a known provider prefix (`opencode-go/`, `opencode/`,
 * `openrouter/`) from a saved model id for catalog comparison. Unknown
 * prefixes and bare ids are returned trimmed and unchanged.
 */
export function stripKnownOpenCodePrefix(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return trimmed;
  const head = trimmed.slice(0, slash).toLowerCase();
  if ((KNOWN_OPENCODE_PREFIXES as readonly string[]).includes(head)) {
    return trimmed.slice(slash + 1);
  }
  return trimmed;
}

export type OpenCodeModelMode = 'go' | 'zen' | 'manual';

/**
 * Resolve which model entry mode a persisted provider value selects:
 * `opencode-go` (Go / Go Plus subscriptions) offers the Go dropdown,
 * `opencode` (Zen) and everything else use a manual model text input.
 */
export function resolveOpenCodeModelMode(provider: string | undefined): OpenCodeModelMode {
  const value = (provider ?? '').trim().toLowerCase();
  if (value === 'opencode-go') return 'go';
  if (value === 'opencode') return 'zen';
  return 'manual';
}

const NO_MODELS: readonly string[] = [];

/** Catalog for an entry mode (manual modes use a text input: no options). */
export function modelsForOpenCodeMode(mode: OpenCodeModelMode): readonly string[] {
  if (mode === 'go') return OPENCODE_GO_MODELS;
  if (mode === 'zen') return OPENCODE_ZEN_MODELS;
  return NO_MODELS;
}
