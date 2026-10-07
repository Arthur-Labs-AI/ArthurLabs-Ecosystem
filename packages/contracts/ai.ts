/**
 * AI provider setup (M04.5): which provider serves each capability, and whether a credential is stored for it.
 *
 * A credential belongs to a PROVIDER ACCOUNT, and capabilities reference it: one OpenAI key serves the language model, speech
 * recognition and embeddings. Pointing a capability at another provider later changes a binding, not this model.
 *
 * Nothing here can carry a credential. The only place a secret crosses the boundary is the single `setProviderCredential`
 * call, which is write-only: no operation anywhere returns it, and no payload below has a field that could hold it.
 *
 * Mirrors the native `AiConfig` (`src-tauri/src/providers/ai.rs`).
 */

export const AI_PROVIDERS = ["openai"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** What Arthur needs a cloud provider for. There is no text-to-speech capability: the app has no TTS runtime. */
export const AI_CAPABILITIES = ["llm", "stt", "embeddings"] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export interface AiProviderStatus {
  id: AiProviderId;
  name: string;
  /** Whether a credential is stored. The value itself is never available. */
  hasCredential: boolean;
}

export interface AiCapabilityStatus {
  capability: AiCapability;
  provider: AiProviderId;
  providerName: string;
  /** The models in use. The first one is the one to show. */
  models: string[];
  /** `ready`: the bound provider has a credential. `needsCredential`: it does not, so this capability is unavailable. */
  status: "ready" | "needsCredential";
}

export interface AiConfig {
  /** First-run Setup was finished or skipped. Not a statement that anything is configured. */
  setupCompleted: boolean;
  providers: AiProviderStatus[];
  capabilities: AiCapabilityStatus[];
}

/**
 * `connected`: the provider accepted the credential and can see the model. `invalidCredential`: it rejected it.
 * `unreachable`: no answer (offline, timeout, outage). `unavailable`: the credential works but this account cannot use the
 * model (or is rate limited). `notConfigured`: nothing to test.
 */
export const PROVIDER_TEST_OUTCOMES = ["connected", "invalidCredential", "unreachable", "unavailable", "notConfigured"] as const;
export type ProviderTestOutcome = (typeof PROVIDER_TEST_OUTCOMES)[number];

export interface ProviderTestResult {
  capability: AiCapability;
  outcome: ProviderTestOutcome;
}

export const AI_ERROR_CODES = ["invalidCredentialFormat", "unknownProvider", "unknownCapability", "storage"] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export interface AiErrorPayload {
  code: AiErrorCode;
  message?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

export function isAiConfig(value: unknown): value is AiConfig {
  if (!isRecord(value) || typeof value.setupCompleted !== "boolean" || !Array.isArray(value.providers) || !Array.isArray(value.capabilities)) return false;
  return (
    value.providers.every((p) => isRecord(p) && isOneOf(AI_PROVIDERS, p.id) && typeof p.name === "string" && typeof p.hasCredential === "boolean") &&
    value.capabilities.every(
      (c) =>
        isRecord(c) &&
        isOneOf(AI_CAPABILITIES, c.capability) &&
        isOneOf(AI_PROVIDERS, c.provider) &&
        typeof c.providerName === "string" &&
        Array.isArray(c.models) &&
        c.models.every((m) => typeof m === "string") &&
        (c.status === "ready" || c.status === "needsCredential"),
    )
  );
}

export function isProviderTestResult(value: unknown): value is ProviderTestResult {
  return isRecord(value) && isOneOf(AI_CAPABILITIES, value.capability) && isOneOf(PROVIDER_TEST_OUTCOMES, value.outcome);
}

export function isAiErrorPayload(value: unknown): value is AiErrorPayload {
  return isRecord(value) && isOneOf(AI_ERROR_CODES, value.code);
}

/** The capability's status, or `undefined` before the configuration has been read. */
export function capabilityStatus(config: AiConfig | null, capability: AiCapability): AiCapabilityStatus | undefined {
  return config?.capabilities.find((c) => c.capability === capability);
}

/** True only when the configuration is known AND the capability has what it needs. Unknown is not "ready". */
export function isCapabilityReady(config: AiConfig | null, capability: AiCapability): boolean {
  return capabilityStatus(config, capability)?.status === "ready";
}
