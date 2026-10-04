use tauri::State;

use crate::audio::error::VoiceError;
use crate::audio::voice_capture::VoiceCaptureService;
use crate::storage::capture_store::{Capture, CaptureStore};

#[tauri::command]
pub async fn start_voice_capture(voice: State<'_, VoiceCaptureService>) -> Result<(), VoiceError> {
    voice.start().await
}

/// Stops recording, transcribes, and returns the persisted voice Capture.
#[tauri::command]
pub async fn finish_voice_capture(
    voice: State<'_, VoiceCaptureService>,
    store: State<'_, CaptureStore>,
) -> Result<Capture, VoiceError> {
    voice.stop(&store).await
}

#[tauri::command]
pub async fn cancel_voice_capture(voice: State<'_, VoiceCaptureService>) -> Result<(), VoiceError> {
    voice.cancel().await;
    Ok(())
}
