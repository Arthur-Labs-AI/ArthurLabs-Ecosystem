use std::path::Path;

use crate::async_util::BoxFuture;

use super::error::VoiceError;

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
}
