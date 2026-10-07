//! Which providers exist, which capabilities Arthur has, and which model serves each.
//!
//! A *credential* belongs to a provider account (one OpenAI key serves every OpenAI capability). A *capability* is bound to a
//! provider and uses that provider's credential. Adding DeepSeek for the LLM later means one more `ProviderId` and a different
//! binding; the credential store, the commands and the UI model do not change.
//!
//! Text-to-speech is deliberately absent: the app has no TTS runtime, so there is nothing to configure.

use serde::Serialize;

use super::embed::OPENAI_MODEL as OPENAI_EMBEDDING_MODEL;
use crate::graph::openai::VERIFIER_MODEL;
use crate::stt::openai::DEFAULT_MODEL as OPENAI_STT_MODEL;
use super::chat::DEFAULT_MODEL as OPENAI_LLM_MODEL;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderId {
    #[serde(rename = "openai")]
    OpenAi,
}

impl ProviderId {
    pub const ALL: [ProviderId; 1] = [ProviderId::OpenAi];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "openai",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.as_str() == raw)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "OpenAI",
        }
    }

    /// Where this provider's models are listed. Used only to check a credential without spending tokens.
    pub fn api_base(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "https://api.openai.com/v1",
        }
    }

    pub fn supports(self, capability: Capability) -> bool {
        match self {
            ProviderId::OpenAi => matches!(capability, Capability::Llm | Capability::Stt | Capability::Embeddings),
        }
    }
}

/// What Arthur needs a cloud provider for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// Thought Distillation, relation proposals and Ask Arthur's grounded answer.
    Llm,
    /// Voice Capture transcription.
    Stt,
    /// Semantic Recall vectors. Having a connection never turns Semantic Recall on.
    Embeddings,
}

impl Capability {
    pub const ALL: [Capability; 3] = [Capability::Llm, Capability::Stt, Capability::Embeddings];

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Llm => "llm",
            Capability::Stt => "stt",
            Capability::Embeddings => "embeddings",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|capability| capability.as_str() == raw)
    }

    pub fn default_provider(self) -> ProviderId {
        ProviderId::OpenAi
    }
}

/// The models a capability uses on a provider. The first is the one shown; every one is checked by the provider test.
pub fn models(provider: ProviderId, capability: Capability) -> &'static [&'static str] {
    match (provider, capability) {
        (ProviderId::OpenAi, Capability::Llm) => &[OPENAI_LLM_MODEL, VERIFIER_MODEL],
        (ProviderId::OpenAi, Capability::Stt) => &[OPENAI_STT_MODEL],
        (ProviderId::OpenAi, Capability::Embeddings) => &[OPENAI_EMBEDDING_MODEL],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_capability_has_a_model_on_its_default_provider() {
        for capability in Capability::ALL {
            let provider = capability.default_provider();
            assert!(provider.supports(capability));
            assert!(!models(provider, capability).is_empty());
        }
    }

    #[test]
    fn the_wire_names_are_exactly_the_names_the_contracts_use() {
        for provider in ProviderId::ALL {
            assert_eq!(serde_json::to_value(provider).unwrap(), provider.as_str());
        }
        for capability in Capability::ALL {
            assert_eq!(serde_json::to_value(capability).unwrap(), capability.as_str());
        }
    }

    #[test]
    fn names_round_trip_and_unknown_names_are_rejected() {
        for provider in ProviderId::ALL {
            assert_eq!(ProviderId::parse(provider.as_str()), Some(provider));
        }
        for capability in Capability::ALL {
            assert_eq!(Capability::parse(capability.as_str()), Some(capability));
        }
        assert_eq!(ProviderId::parse("tts"), None);
        assert_eq!(Capability::parse("tts"), None);
    }
}
