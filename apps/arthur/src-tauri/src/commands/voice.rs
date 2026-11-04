use tauri::State;

use crate::audio::error::VoiceError;
use crate::audio::recorder::MicrophonePermission;
use crate::audio::voice_capture::VoiceCaptureService;
use crate::runtime::RuntimeHandle;
use crate::storage::capture_store::Capture;

#[tauri::command]
pub async fn start_voice_capture(voice: State<'_, VoiceCaptureService>) -> Result<(), VoiceError> {
    voice.start().await
}

/// Stops recording, transcribes, and returns the persisted voice Capture.
#[tauri::command]
pub async fn finish_voice_capture(
    voice: State<'_, VoiceCaptureService>,
    store: State<'_, RuntimeHandle>,
    project_id: Option<String>,
) -> Result<Capture, VoiceError> {
    voice.stop_in(&store, project_id.as_deref()).await
}

#[tauri::command]
pub async fn cancel_voice_capture(voice: State<'_, VoiceCaptureService>) -> Result<(), VoiceError> {
    voice.cancel().await;
    Ok(())
}

/// Transcribes the recording kept after a retryable failure, without recording again. Returns the persisted Capture.
#[tauri::command]
pub async fn retry_voice_transcription(
    voice: State<'_, VoiceCaptureService>,
    store: State<'_, RuntimeHandle>,
    project_id: Option<String>,
) -> Result<Capture, VoiceError> {
    voice.retry_in(&store, project_id.as_deref()).await
}

/// Deletes the kept recording. Always succeeds; there may be nothing to delete.
#[tauri::command]
pub fn discard_voice_recording(voice: State<'_, VoiceCaptureService>) -> Result<(), VoiceError> {
    voice.discard();
    Ok(())
}

/// The microphone permission, read without asking.
#[tauri::command]
pub async fn get_microphone_permission(
    voice: State<'_, VoiceCaptureService>,
) -> Result<MicrophonePermission, VoiceError> {
    voice.microphone_permission().await
}

/// Opens this app's page in the system settings.
#[tauri::command]
pub async fn open_app_settings(voice: State<'_, VoiceCaptureService>) -> Result<(), VoiceError> {
    voice.open_app_settings().await
}
