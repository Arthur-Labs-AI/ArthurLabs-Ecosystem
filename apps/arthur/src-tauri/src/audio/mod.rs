//! Voice capture: microphone -> transcript -> Capture.
//!
//! Audio lifecycle (privacy invariant: audio is transient, the transcript is the
//! only thing kept):
//!
//! 1. `start` picks a file in the app *cache* directory and the platform recorder
//!    writes to it. Only this module knows the path; it never reaches the UI.
//! 2. `stop` finalizes the file, reads it, and sends the bytes to speech-to-text.
//! 3. The file is deleted on every exit path: transcription success, any
//!    terminal failure, an interrupted recording, and `cancel`. A drop-guard
//!    enforces this, so no code path can forget it.
//! 4. Files left behind by a crash are purged at the next launch.
//! 5. Only the transcript is persisted, as an ordinary `Capture` with
//!    `source: "voice"` in the existing capture store.

pub mod error;
pub mod recorder;
pub mod voice_capture;

#[cfg(target_os = "android")]
pub mod android;
