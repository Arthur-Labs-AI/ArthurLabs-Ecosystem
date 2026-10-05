//! Android microphone recorder: a thin bridge to the Kotlin `AudioPlugin`
//! (`gen/android/app/src/main/java/dev/kaloyan/arthur/AudioPlugin.kt`).

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

use crate::async_util::BoxFuture;

use super::error::VoiceError;
use super::recorder::{MicrophonePermission, Recorder};

const PLUGIN_IDENTIFIER: &str = "dev.kaloyan.arthur";
const PLUGIN_CLASS: &str = "AudioPlugin";

pub struct AndroidRecorder {
    handle: PluginHandle<Wry>,
}

#[derive(Serialize)]
struct StartArgs<'a> {
    path: &'a str,
}

#[derive(Deserialize)]
struct PermissionPayload {
    state: String,
}

impl AndroidRecorder {
    async fn call(&self, command: &str, payload: impl Serialize) -> Result<(), VoiceError> {
        self.handle
            .run_mobile_plugin_async::<serde_json::Value>(command, payload)
            .await
            .map(|_| ())
            .map_err(|error| map_plugin_error(&error))
    }
}

/// The Kotlin plugin rejects with one of the contract codes; anything else is a generic failure.
fn map_plugin_error(error: &tauri::plugin::mobile::PluginInvokeError) -> VoiceError {
    use tauri::plugin::mobile::PluginInvokeError::InvokeRejected;
    match error {
        InvokeRejected(response) => match response.code.as_deref() {
            Some("microphone_permission_denied") => VoiceError::MicrophonePermissionDenied,
            Some("already_recording") => VoiceError::AlreadyRecording,
            Some("not_recording") => VoiceError::NotRecording,
            Some("recording_interrupted") => VoiceError::RecordingInterrupted,
            _ => VoiceError::RecordingFailed,
        },
        _ => VoiceError::RecordingFailed,
    }
}

impl Recorder for AndroidRecorder {
    fn start<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), VoiceError>> {
        Box::pin(async move {
            let path = path.to_str().ok_or(VoiceError::RecordingFailed)?;
            self.call("startRecording", StartArgs { path }).await
        })
    }

    fn stop<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>> {
        Box::pin(self.call("stopRecording", ()))
    }

    fn cancel<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self.call("cancelRecording", ()).await;
        })
    }

    fn permission<'a>(&'a self) -> BoxFuture<'a, Result<MicrophonePermission, VoiceError>> {
        Box::pin(async move {
            let payload = self
                .handle
                .run_mobile_plugin_async::<PermissionPayload>("getMicrophonePermission", ())
                .await
                .map_err(|error| map_plugin_error(&error))?;
            Ok(parse_permission(&payload.state))
        })
    }

    fn open_settings<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>> {
        Box::pin(self.call("openAppSettings", ()))
    }
}

/// The plugin reports one of four words. Anything else is treated as "unknown", which only means Speak may ask.
fn parse_permission(state: &str) -> MicrophonePermission {
    match state {
        "granted" => MicrophonePermission::Granted,
        "denied" => MicrophonePermission::Denied,
        "denied_permanently" => MicrophonePermission::DeniedPermanently,
        _ => MicrophonePermission::Unknown,
    }
}

/// Registers the Kotlin plugin and makes the recorder available as managed state.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("arthur-audio")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
            app.manage(Arc::new(AndroidRecorder { handle }));
            Ok(())
        })
        .build()
}
