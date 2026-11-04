use std::path::Path;

use serde::Serialize;

use crate::async_util::BoxFuture;

use super::error::VoiceError;

/// What the app may do about the microphone, as the platform sees it. Semantic only: no platform names, no intents.
/// Mirrors `MICROPHONE_PERMISSION_STATES` in `packages/contracts/capture.ts`.
// Only the Android bridge constructs most variants, so desktop builds see them as unused.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MicrophonePermission {
    /// Not granted and never asked, or this platform cannot say. Speak may ask.
    Unknown,
    Granted,
    /// Refused, but the system will still show its dialog if asked again.
    Denied,
    /// Refused for good: the system will not ask again, so only the app's settings can change it.
    DeniedPermanently,
}

/// Platform microphone boundary. An implementation records to the file path it
/// is given and knows nothing about transcription or storage.
pub trait Recorder: Send + Sync {
    /// Begins recording to `path`. Resolves once recording has actually started,
    /// which includes asking the user for microphone permission.
    fn start<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), VoiceError>>;
    /// Stops recording and finalizes the file at the path given to `start`.
    fn stop<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>>;
    /// Stops recording and discards the audio. Never fails.
    fn cancel<'a>(&'a self) -> BoxFuture<'a, ()>;
    /// The current permission, WITHOUT asking: reading it must never show a dialog.
    fn permission<'a>(&'a self) -> BoxFuture<'a, Result<MicrophonePermission, VoiceError>>;
    /// Opens the app's own page in the system settings, where the microphone can be allowed again.
    fn open_settings<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>>;
}

/// Recorder for platforms without microphone capture in this milestone.
pub struct UnsupportedRecorder;

impl Recorder for UnsupportedRecorder {
    fn start<'a>(&'a self, _path: &'a Path) -> BoxFuture<'a, Result<(), VoiceError>> {
        Box::pin(async { Err(VoiceError::Unavailable) })
    }

    fn stop<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>> {
        Box::pin(async { Err(VoiceError::NotRecording) })
    }

    fn cancel<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    fn permission<'a>(&'a self) -> BoxFuture<'a, Result<MicrophonePermission, VoiceError>> {
        Box::pin(async { Ok(MicrophonePermission::Unknown) })
    }

    fn open_settings<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>> {
        Box::pin(async { Err(VoiceError::Unavailable) })
    }
}
