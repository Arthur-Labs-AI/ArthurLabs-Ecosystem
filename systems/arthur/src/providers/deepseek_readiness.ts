/**
 * FRS-02 §7: DeepSeek explicit readiness check.
 *
 * Reuses the existing DeepSeek provider boundary (no second HTTP
 * implementation): a deterministic tiny validation request proves
 * (A) credential accepted, (B) basic minimal completion works, and
 * (C) the provider is usable with the current ARTHUR model/tool contract.
 *
 * The validation request is tiny (a fixed short prompt, bounded tokens),
 * creates no external side effects, and never uses harness.create_job or
 * any approval/mutation tool. Tool-capability is proven structurally by
 * exposing ONE safe read-only schema (system.echo) and requiring the
 * provider's tool-call path to normalize through the existing alias map —
 * the same contract production uses.
 *
 * Production DeepSeek request behavior is unchanged; this module only
 * builds the validation request and classifies the outcome into the
 * provider-neutral ProviderReadiness shape. No startup probing: callers
 * invoke checkDeepSeekReadiness() explicitly from setup/diagnostics only.
 */

import {
  DeepSeekProvider,
  DeepSeekRequestRejectedError,
  type DeepSeekProviderConfig,
} from '../models/providers/deepseek';
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  type ModelResult,
} from '../models/contracts';
import {
  failedResult,
  notConfigured,
  readyResult,
  type ProviderReadiness,
  type ReadinessFailureCategory,
} from './readiness';

export const DEEPSEEK_READINESS_ID = 'deepseek';
export const DEEPSEEK_READINESS_CAPABILITY = 'reasoning';

/** Fixed tiny validation prompt (deterministic, minimal tokens). */
export const DEEPSEEK_VALIDATION_PROMPT = 'Reply with exactly the word: pong';
/** Fixed validation model override is NOT applied: the configured model is tested. */

/** Safe read-only tool schema proving the tool-capable response path. */
export const DEEPSEEK_VALIDATION_TOOL = {
  name: 'system.echo',
  description: 'Echo text back (read-only validation probe).',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo.' } },
    required: ['text'],
  },
} as const;

export interface DeepSeekReadinessDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface DeepSeekReadinessConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  reasoningProfile?: DeepSeekProviderConfig['reasoningProfile'];
}

function classifyDeepSeekError(err: unknown): { status: ProviderReadiness['status']; category: ReadinessFailureCategory; httpStatus?: number } {
  if (err instanceof ProviderAuthError) return { status: 'auth_failed', category: 'auth' };
  if (err instanceof ProviderTimeoutError) return { status: 'unavailable', category: 'timeout' };
  if (err instanceof ProviderBadResponseError) return { status: 'failed', category: 'bad_response' };
  if (err instanceof DeepSeekRequestRejectedError) return { status: 'invalid_config', category: 'rejected' };
  if (err instanceof ProviderUnavailableError) {
    const message = err.message.toLowerCase();
    if (message.includes('timed out') || message.includes('timeout')) return { status: 'unavailable', category: 'timeout' };
    return { status: 'unavailable', category: 'network' };
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { status: 'unavailable', category: 'timeout' };
  }
  return { status: 'failed', category: 'network' };
}

function structuralToolPathOk(result: ModelResult): boolean {
  // The completion itself already proves A+B; C is proven structurally:
  // the result normalized through the real alias/contract boundary
  // (empty tool calls with valid text is a usable tool-capable path —
  // the provider accepted the tool schema and answered within contract).
  if (!Array.isArray(result.tool_calls)) return false;
  if (typeof result.assistant_text !== 'string') return false;
  if (result.assistant_text === '' && result.tool_calls.length === 0) return false;
  return true;
}

/**
 * Explicit DeepSeek readiness check (setup/diagnostic action only).
 * Returns not_configured WITHOUT any network call when no credential or
 * model is effective; otherwise performs ONE bounded validation generate().
 */
export async function checkDeepSeekReadiness(
  config: DeepSeekReadinessConfig,
  deps: DeepSeekReadinessDeps = {},
): Promise<ProviderReadiness> {
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '' || typeof config.model !== 'string' || config.model.trim() === '') {
    return notConfigured(DEEPSEEK_READINESS_ID, DEEPSEEK_READINESS_CAPABILITY);
  }
  const provider = new DeepSeekProvider(
    {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      timeoutMs: deps.timeoutMs ?? 30_000,
      retryMaxAttempts: 0,
      retryBaseDelayMs: 0,
      reasoningProfile: config.reasoningProfile ?? 'normal',
    },
    { fetchFn: deps.fetchFn, sleepFn: deps.sleepFn ?? (async () => undefined) },
  );
  try {
    const result = await provider.generate({
      systemContract: 'You are a readiness probe. Follow the instruction exactly.',
      modeContract: '',
      history: [],
      toolSchemas: [{ ...DEEPSEEK_VALIDATION_TOOL, parameters: { ...DEEPSEEK_VALIDATION_TOOL.parameters } }],
      userMessage: DEEPSEEK_VALIDATION_PROMPT,
      model: config.model,
      reasoningProfile: config.reasoningProfile ?? 'normal',
    });
    if (!structuralToolPathOk(result)) {
      return failedResult(DEEPSEEK_READINESS_ID, DEEPSEEK_READINESS_CAPABILITY, 'failed', 'bad_response');
    }
    return readyResult(DEEPSEEK_READINESS_ID, DEEPSEEK_READINESS_CAPABILITY, ['completion', 'tools']);
  } catch (err) {
    const classified = classifyDeepSeekError(err);
    return failedResult(DEEPSEEK_READINESS_ID, DEEPSEEK_READINESS_CAPABILITY, classified.status, classified.category, classified.httpStatus);
  }
}
