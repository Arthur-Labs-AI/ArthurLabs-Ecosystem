//! Voice capture: microphone -> transcript -> Capture.
//!
//! Audio lifecycle (privacy invariant: audio is transient, the transcript is the
//! only thing kept):
//!
//! 1. `start` picks a file in the app *cache* directory and the platform recorder
//!    writes to it. Only this module knows the path; it never reaches the UI.
//! 2. `stop` finalizes the file, reads it, and sends the bytes to speech-to-text.
//! 3. The file is deleted on every exit path: transcription success, any
//!    final failure, an interrupted recording, and `cancel`. A drop-guard
//!    enforces this, so no code path can forget it.
//!    One exception, and only one: a transcription that failed in a way that
//!    may pass (no connection, a busy provider) keeps the file for a retry. It
//!    is kept for at most 15 minutes and deleted by a successful retry, a
//!    discard, starting a new recording, or the deadline, whichever is first.
//!    It stays in the app-private cache, its path never leaves this module, and
//!    nothing about it is logged or stored in the database.
//! 4. Files left behind by a crash, or by a retry that was still open when the
//!    app died, are purged at the next launch.
//! 5. Only the transcript is persisted, as an ordinary `Capture` with
//!    `source: "voice"` in the existing capture store.

pub mod error;
pub mod recorder;
pub mod voice_capture;

#[cfg(target_os = "android")]
pub mod android;
