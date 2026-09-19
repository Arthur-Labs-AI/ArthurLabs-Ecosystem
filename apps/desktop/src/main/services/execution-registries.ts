/**
 * Production-only execution registry (desktop).
 *
 * Sentry Desktop exposes no simulation mode: the single registry contains
 * the real Muse / DeepSeek / GLM registrations proven by the CLI.
 * No provider clients are implemented here.
 */
import { HarnessAdapterRegistry } from '@qa/harness-protocol';
import { createMuseRegistration } from '@qa/harness-muse';
import { createDeepSeekRegistration } from '@qa/harness-deepseek';
import { createGlmRegistration } from '@qa/harness-claude-code';

export function createProductionRegistry(): HarnessAdapterRegistry {
  return new HarnessAdapterRegistry()
    .register(createMuseRegistration())
    .register(createDeepSeekRegistration())
    .register(createGlmRegistration());
}

export interface ProductionReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export function productionReadiness(input: {
  readonly deepseekConfigured: boolean;
  readonly museAvailable: boolean;
  readonly glmConfigured: boolean;
}): ProductionReadiness {
  const reasons: string[] = [];
  if (!input.deepseekConfigured) reasons.push('DeepSeek credential missing');
  if (!input.museAvailable) reasons.push('Muse login unavailable');
  if (!input.glmConfigured) reasons.push('GLM credential missing');
  return { ready: reasons.length === 0, reasons };
}
