//! Native boundary of voice output (M04.6): speak, stop, status. The audio never crosses it; only text goes in and a coarse status
//! comes out. There is no operation that returns audio, a provider response, an endpoint or a credential.

use std::sync::Arc;

use tauri::State;

use crate::providers::ai::{AiError, AiService};
use crate::tts::service::{SpeechError, SpeechService, SpeechStart, SpeechStatus};

/// The short fixed sentence used by "Test voice": cheap, and it names nothing from the user's knowledge.
pub const TEST_SENTENCE: &str = "Hello, I'm Arthur. This is how I sound.";

fn choice(
    ai: &AiService,
    voice: Option<&str>,
    model: Option<&str>,
) -> Result<(String, String), SpeechError> {
    // The only way a choice is refused is an unknown voice or model.
    ai.tts_choice(voice, model)
        .map_err(|_: AiError| SpeechError::UnsupportedVoiceOrModel)
}

/// Reads `text` aloud with the configured voice (or the validated `voice`/`model` the caller names). Starts a session and returns at
/// once; the session's progress and any failure are read with `get_speech_status`. Starting a session stops the previous one.
#[tauri::command]
pub async fn speak_text(
    ai: State<'_, Arc<AiService>>,
    speech: State<'_, SpeechService>,
    text: String,
    voice: Option<String>,
    model: Option<String>,
) -> Result<SpeechStart, SpeechError> {
    let (model, voice) = choice(&ai, voice.as_deref(), model.as_deref())?;
    speech.speak(&text, model, voice).await
}

#[tauri::command]
pub async fn test_voice(
    ai: State<'_, Arc<AiService>>,
    speech: State<'_, SpeechService>,
) -> Result<SpeechStart, SpeechError> {
    let (model, voice) = choice(&ai, None, None)?;
    speech.speak(TEST_SENTENCE, model, voice).await
}

#[tauri::command]
pub async fn stop_speech(speech: State<'_, SpeechService>) -> Result<(), ()> {
    speech.stop().await;
    Ok(())
}

#[tauri::command]
pub fn get_speech_status(speech: State<'_, SpeechService>) -> SpeechStatus {
    speech.status()
}
