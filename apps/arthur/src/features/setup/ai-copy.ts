import type { AiCapability, ProviderTestOutcome } from "@arthur/contracts";

/** What a capability is for, in the words a person uses. */
export const CAPABILITY_LABEL: Record<AiCapability, string> = {
  llm: "Organizing and Ask Arthur",
  stt: "Voice Capture",
  embeddings: "Semantic Recall embeddings",
};

/** What stops working without a credential, and what keeps working. */
export const CAPABILITY_FALLBACK: Record<AiCapability, string> = {
  llm: "Captures are still saved as you wrote them, but Arthur can’t organize them or answer questions.",
  stt: "Typed Capture still works. Voice Capture is unavailable.",
  embeddings: "Recall still finds ideas by the words you used. Semantic Recall is unavailable.",
};

export const OUTCOME_LABEL: Record<ProviderTestOutcome, string> = {
  connected: "Connected",
  invalidCredential: "Invalid credential",
  unreachable: "Provider unreachable",
  unavailable: "Capability unavailable",
  notConfigured: "No credential to test",
};

export const OUTCOME_DETAIL: Record<ProviderTestOutcome, string> = {
  connected: "The provider accepted the key and can see the model.",
  invalidCredential: "The provider rejected this key. Check it and try again.",
  unreachable: "Arthur couldn’t reach the provider. Check the connection and try again.",
  unavailable: "The key works, but this account can’t use the model right now.",
  notConfigured: "Add a key first.",
};
