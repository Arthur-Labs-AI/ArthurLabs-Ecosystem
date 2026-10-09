//! Which providers exist, which capabilities Arthur has, and which model serves each.
//!
//! A *credential* belongs to a provider account (one OpenAI key serves every OpenAI capability). A *capability* is bound to a
//! provider and uses that provider's credential. Adding DeepSeek for the LLM later means one more `ProviderId` and a different
//! binding; the credential store, the commands and the UI model do not change.
//!
//! Text-to-speech (`Capability::Tts`) reuses the OpenAI provider credential: a capability is bound to a provider, never to its own key.

use serde::Serialize;

use super::embed::OPENAI_MODEL as OPENAI_EMBEDDING_MODEL;
use super::chat::LUNA_MODEL;
use crate::stt::openai::DEFAULT_MODEL as OPENAI_STT_MODEL;
use crate::tts::openai::{DEFAULT_MODEL as OPENAI_TTS_MODEL, DEFAULT_VOICE as OPENAI_TTS_VOICE, MODELS as OPENAI_TTS_MODELS, VOICES as OPENAI_TTS_VOICES};
use super::chat::DEFAULT_MODEL as OPENAI_LLM_MODEL;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderId {
    #[serde(rename = "openai")]
    OpenAi,
    /// TypeSafe (JEV), the Automatic Thought Evolution identity classifier. A NATIVE-ONLY credential slot: it is deliberately not in
    /// `ALL`, so it is not listed in AI & Voice, `ProviderId::parse` never yields it, and no UI command can set, read or test it. It
    /// serves no `Capability` (`supports` is false everywhere) and never borrows another provider's key.
    #[serde(rename = "typesafe")]
    TypeSafe,
    /// Z.ai (Zhipu GLM, international service), the independent revision VERIFIER (M04.7B Phase 4C). Native-only like `TypeSafe`: not in
    /// `ALL`, never parsed from UI input, serves no `Capability`, and never borrows another provider's key.
    #[serde(rename = "zai")]
    #[allow(dead_code)] // deliberately not constructed by shipped code until the verifier is activated (Phase 5)
    Zai,
}

impl ProviderId {
    pub const ALL: [ProviderId; 1] = [ProviderId::OpenAi];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "openai",
            ProviderId::TypeSafe => "typesafe",
            ProviderId::Zai => "zai",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.as_str() == raw)
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "OpenAI",
            ProviderId::TypeSafe => "TypeSafe",
            ProviderId::Zai => "Z.ai",
        }
    }

    /// Where this provider's models are listed. Used only to check a credential without spending tokens.
    pub fn api_base(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "https://api.openai.com/v1",
            ProviderId::TypeSafe => "https://api.typesafe.ai/v1",
            ProviderId::Zai => "https://api.z.ai/api/paas/v4",
        }
    }

    pub fn supports(self, capability: Capability) -> bool {
        match self {
            ProviderId::OpenAi => matches!(capability, Capability::Llm | Capability::Stt | Capability::Embeddings | Capability::Tts),
            ProviderId::TypeSafe | ProviderId::Zai => false,
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
    /// Reading an Arthur answer aloud. Output only: the selected text is sent to the provider, audio comes back and is never kept.
    Tts,
}

impl Capability {
    pub const ALL: [Capability; 4] = [Capability::Llm, Capability::Stt, Capability::Embeddings, Capability::Tts];

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Llm => "llm",
            Capability::Stt => "stt",
            Capability::Embeddings => "embeddings",
            Capability::Tts => "tts",
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
        (ProviderId::OpenAi, Capability::Llm) => &[OPENAI_LLM_MODEL, LUNA_MODEL],
        (ProviderId::OpenAi, Capability::Stt) => &[OPENAI_STT_MODEL],
        (ProviderId::OpenAi, Capability::Embeddings) => &[OPENAI_EMBEDDING_MODEL],
        (ProviderId::OpenAi, Capability::Tts) => &[OPENAI_TTS_MODEL],
        (ProviderId::TypeSafe | ProviderId::Zai, _) => &[],
    }
}

/// What a provider's text-to-speech accepts. Explicit so a request for an unknown voice or model is refused before any network call.
pub struct TtsOptions {
    pub models: &'static [&'static str],
    pub voices: &'static [&'static str],
    pub default_model: &'static str,
    pub default_voice: &'static str,
}

pub fn tts_options(provider: ProviderId) -> TtsOptions {
    match provider {
        ProviderId::OpenAi => TtsOptions { models: OPENAI_TTS_MODELS, voices: OPENAI_TTS_VOICES, default_model: OPENAI_TTS_MODEL, default_voice: OPENAI_TTS_VOICE },
        ProviderId::TypeSafe | ProviderId::Zai => TtsOptions { models: &[], voices: &[], default_model: "", default_voice: "" },
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
    fn the_llm_models_are_the_ones_arthur_still_uses_and_gpt_5_mini_is_gone() {
        let llm = models(ProviderId::OpenAi, Capability::Llm);
        assert_eq!(llm, ["gpt-4.1-mini", "gpt-6-luna"], "Stage A and Ask Arthur stay on gpt-4.1-mini; distillation, synthesis and Stage B are gpt-6-luna");
        assert!(!llm.contains(&"gpt-5-mini"));
    }

    #[test]
    fn the_native_only_slots_serve_no_capability_and_are_invisible_to_the_ui_commands() {
        for (slot, name) in [(ProviderId::TypeSafe, "typesafe"), (ProviderId::Zai, "zai")] {
            assert!(!ProviderId::ALL.contains(&slot), "{name}: not listed in AI & Voice");
            assert_eq!(ProviderId::parse(name), None, "{name}: no UI command can name it");
            assert_eq!(slot.as_str(), name);
            assert!(Capability::ALL.into_iter().all(|capability| !slot.supports(capability) && capability.default_provider() != slot), "{name}");
        }
        assert_ne!(ProviderId::Zai.as_str(), ProviderId::OpenAi.as_str(), "its own credential slot");
    }

    #[test]
    fn names_round_trip_and_unknown_names_are_rejected() {
        for provider in ProviderId::ALL {
            assert_eq!(ProviderId::parse(provider.as_str()), Some(provider));
        }
        for capability in Capability::ALL {
            assert_eq!(Capability::parse(capability.as_str()), Some(capability));
        }
        assert_eq!(ProviderId::parse("tts"), None, "tts is a capability, not a provider");
        assert_eq!(Capability::parse("speech"), None);
        assert_eq!(Capability::parse("tts"), Some(Capability::Tts));
    }
}
