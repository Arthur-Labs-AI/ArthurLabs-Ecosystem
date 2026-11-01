use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::stt::SttError;

/// Why a voice capture attempt failed. `code()` values mirror
/// `VOICE_CAPTURE_ERROR_CODES` in `packages/contracts/capture.ts`.
///
/// Messages are shown to the user, so they never contain credentials, file
/// paths or provider response bodies.
// Some variants are only constructed by the Android bridge, so desktop builds see them as unused.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceError {
    Unavailable,
    MicrophonePermissionDenied,
    AlreadyRecording,
    NotRecording,
    RecordingFailed,
    RecordingInterrupted,
    SttNotConfigured,
    SttFailed(SttError),
    /// A transcription failed in a way that may pass (no connection, a busy provider). The recording is kept, for a
    /// limited time and only inside this process, so it can be transcribed again without speaking again.
    SttRetryable(SttError),
    /// There is no kept recording to retry: it was discarded, expired, or never existed.
    NoRetainedRecording,
    EmptyTranscript,
    CaptureFailed(String),
}

impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            VoiceError::Unavailable => "voice_unavailable",
            VoiceError::MicrophonePermissionDenied => "microphone_permission_denied",
            VoiceError::AlreadyRecording => "already_recording",
            VoiceError::NotRecording => "not_recording",
            VoiceError::RecordingFailed => "recording_failed",
            VoiceError::RecordingInterrupted => "recording_interrupted",
            VoiceError::SttNotConfigured => "stt_not_configured",
            VoiceError::SttFailed(_) => "stt_failed",
            VoiceError::SttRetryable(_) => "stt_retryable",
            VoiceError::NoRetainedRecording => "no_retained_recording",
            VoiceError::EmptyTranscript => "empty_transcript",
            VoiceError::CaptureFailed(_) => "capture_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            VoiceError::Unavailable => "Voice capture is not available on this device.".into(),
            VoiceError::MicrophonePermissionDenied => {
                "Microphone permission was denied. Allow microphone access for Arthur in the system settings and try again.".into()
            }
            VoiceError::AlreadyRecording => "A recording is already in progress.".into(),
            VoiceError::NotRecording => "There is no recording in progress.".into(),
            VoiceError::RecordingFailed => "Recording failed. Nothing was saved.".into(),
            VoiceError::RecordingInterrupted => {
                "Recording was interrupted because Arthur left the foreground. Nothing was saved.".into()
            }
            VoiceError::SttNotConfigured => "Speech-to-text is not configured on this device.".into(),
            VoiceError::SttFailed(cause) => stt_cause_message(cause),
            VoiceError::SttRetryable(cause) => format!("{} {}", stt_cause_message(cause), super::voice_capture::retry_note()),
            VoiceError::NoRetainedRecording => "That recording is no longer kept. Record it again, or type it.".into(),
            VoiceError::EmptyTranscript => "No speech was recognised. Nothing was saved.".into(),
            VoiceError::CaptureFailed(reason) => format!("The transcript could not be saved: {reason}"),
        }
    }
}

impl From<SttError> for VoiceError {
    fn from(error: SttError) -> Self {
        match error {
            SttError::NotConfigured => VoiceError::SttNotConfigured,
            other => VoiceError::SttFailed(other),
        }
    }
}

impl fmt::Display for VoiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for VoiceError {}

/// Serialized as `{ code, message }`, matching `VoiceCaptureErrorPayload`.
impl Serialize for VoiceError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("VoiceError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.message())?;
        state.end()
    }
}

/// What went wrong with the speech service, in words that are safe to show.
fn stt_cause_message(cause: &SttError) -> String {
    match cause {
        SttError::Network => {
            "Could not reach the speech service. Check the connection and try again.".into()
        }
        SttError::Auth(_) => "The speech service rejected the configured credentials.".into(),
        SttError::Provider(status) => {
            format!("The speech service failed (HTTP {status}). Try again.")
        }
        SttError::Protocol => "The speech service returned an unreadable response.".into(),
        SttError::NotConfigured => "Speech-to-text is not configured on this device.".into(),
    }
}
