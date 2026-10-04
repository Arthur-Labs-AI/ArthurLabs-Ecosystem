use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use uuid::Uuid;

use crate::storage::capture_store::{Capture, CaptureStore, CreateCaptureInput};
use crate::stt::Transcriber;

use super::error::VoiceError;
use super::recorder::Recorder;

const FILE_PREFIX: &str = "arthur-recording-";
const FILE_EXTENSION: &str = "m4a";
/// Stay under the provider's 25 MB upload limit.
pub const MAX_RECORDING_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Idle,
    Starting,
    Recording(PathBuf),
    Transcribing,
}

type SharedState = Arc<Mutex<State>>;

fn lock(state: &SharedState) -> MutexGuard<'_, State> {
    // A panic elsewhere must not wedge voice capture forever.
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Deletes the recording and returns the service to `Idle` when dropped, on
/// every exit path (success, error, early return).
struct RecordingGuard {
    path: PathBuf,
    state: SharedState,
}

impl Drop for RecordingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        *lock(&self.state) = State::Idle;
    }
}

pub struct VoiceCaptureService {
    recorder: Arc<dyn Recorder>,
    transcriber: Arc<dyn Transcriber>,
    recordings_dir: PathBuf,
    state: SharedState,
}

impl VoiceCaptureService {
    /// Creates the recordings directory and purges recordings a previous run
    /// left behind (for example after a crash).
    pub fn new(recorder: Arc<dyn Recorder>, transcriber: Arc<dyn Transcriber>, recordings_dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&recordings_dir)?;
        purge_stale_recordings(&recordings_dir);
        Ok(Self { recorder, transcriber, recordings_dir, state: Arc::new(Mutex::new(State::Idle)) })
    }

    pub async fn start(&self) -> Result<(), VoiceError> {
        {
            let mut state = lock(&self.state);
            if *state != State::Idle {
                return Err(VoiceError::AlreadyRecording);
            }
            *state = State::Starting;
        }

        let path = self.recordings_dir.join(format!("{FILE_PREFIX}{}.{FILE_EXTENSION}", Uuid::new_v4()));
        match self.recorder.start(&path).await {
            Ok(()) => {
                *lock(&self.state) = State::Recording(path);
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(&path);
                *lock(&self.state) = State::Idle;
                Err(error)
            }
        }
    }

    /// Stops recording, transcribes, and persists the transcript as a voice Capture.
    pub async fn stop(&self, store: &CaptureStore) -> Result<Capture, VoiceError> {
        let path = {
            let mut state = lock(&self.state);
            match &*state {
                State::Recording(path) => {
                    let path = path.clone();
                    *state = State::Transcribing;
                    path
                }
                _ => return Err(VoiceError::NotRecording),
            }
        };
        // From here on the audio file is deleted and the state reset, whatever happens.
        let _guard = RecordingGuard { path: path.clone(), state: self.state.clone() };

        self.recorder.stop().await?;
        let audio = read_audio(&path)?;
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("recording.m4a");

        let transcript = self.transcriber.transcribe(&audio, file_name).await.map_err(VoiceError::from)?;
        let transcript = transcript.trim();
        if transcript.is_empty() {
            return Err(VoiceError::EmptyTranscript);
        }

        store
            .create(CreateCaptureInput { source: "voice".into(), content: transcript.to_string() })
            .map_err(|error| VoiceError::CaptureFailed(error.to_string()))
    }

    /// Discards an in-progress recording without transcribing it. A no-op in any other state.
    pub async fn cancel(&self) {
        let path = {
            let state = lock(&self.state);
            match &*state {
                State::Recording(path) => path.clone(),
                _ => return,
            }
        };
        self.recorder.cancel().await;
        let _ = fs::remove_file(&path);
        *lock(&self.state) = State::Idle;
    }
}

fn read_audio(path: &Path) -> Result<Vec<u8>, VoiceError> {
    let size = fs::metadata(path).map_err(|_| VoiceError::RecordingFailed)?.len();
    if size == 0 || size > MAX_RECORDING_BYTES {
        return Err(VoiceError::RecordingFailed);
    }
    fs::read(path).map_err(|_| VoiceError::RecordingFailed)
}

fn purge_stale_recordings(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let is_recording = entry.file_name().to_str().is_some_and(|name| name.starts_with(FILE_PREFIX));
        if is_recording {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::async_util::BoxFuture;
    use crate::stt::SttError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeRecorder {
        start_error: Mutex<Option<VoiceError>>,
        stop_error: Mutex<Option<VoiceError>>,
        audio: Vec<u8>,
        active: Mutex<Option<PathBuf>>,
        cancelled: AtomicUsize,
    }

    impl FakeRecorder {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                start_error: Mutex::new(None),
                stop_error: Mutex::new(None),
                audio: b"FAKE-M4A".to_vec(),
                active: Mutex::new(None),
                cancelled: AtomicUsize::new(0),
            })
        }
    }

    impl Recorder for FakeRecorder {
        fn start<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<(), VoiceError>> {
            Box::pin(async move {
                if let Some(error) = self.start_error.lock().unwrap().clone() {
                    return Err(error);
                }
                fs::write(path, &self.audio).unwrap();
                *self.active.lock().unwrap() = Some(path.to_path_buf());
                Ok(())
            })
        }

        fn stop<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>> {
            Box::pin(async move { self.stop_error.lock().unwrap().clone().map_or(Ok(()), Err) })
        }

        fn cancel<'a>(&'a self) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.cancelled.fetch_add(1, Ordering::SeqCst);
            })
        }
    }

    struct FakeTranscriber {
        result: Mutex<Result<String, SttError>>,
        calls: AtomicUsize,
        received: Mutex<Vec<u8>>,
    }

    impl FakeTranscriber {
        fn returning(result: Result<&str, SttError>) -> Arc<Self> {
            Arc::new(Self {
                result: Mutex::new(result.map(String::from)),
                calls: AtomicUsize::new(0),
                received: Mutex::new(Vec::new()),
            })
        }
        fn set(&self, result: Result<&str, SttError>) {
            *self.result.lock().unwrap() = result.map(String::from);
        }
    }

    impl Transcriber for FakeTranscriber {
        fn transcribe<'a>(&'a self, audio: &'a [u8], _file_name: &'a str) -> BoxFuture<'a, Result<String, SttError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                *self.received.lock().unwrap() = audio.to_vec();
                self.result.lock().unwrap().clone()
            })
        }
    }

    struct Harness {
        service: VoiceCaptureService,
        recorder: Arc<FakeRecorder>,
        stt: Arc<FakeTranscriber>,
        store: CaptureStore,
        dir: tempfile::TempDir,
    }

    fn harness(stt_result: Result<&str, SttError>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let recorder = FakeRecorder::new();
        let stt = FakeTranscriber::returning(stt_result);
        let service = VoiceCaptureService::new(recorder.clone(), stt.clone(), dir.path().join("recordings")).unwrap();
        Harness { service, recorder, stt, store: CaptureStore::open_in_memory().unwrap(), dir }
    }

    impl Harness {
        fn recordings(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(self.dir.path().join("recordings"))
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
        fn start(&self) -> Result<(), VoiceError> {
            tauri::async_runtime::block_on(self.service.start())
        }
        fn stop(&self) -> Result<Capture, VoiceError> {
            tauri::async_runtime::block_on(self.service.stop(&self.store))
        }
        fn cancel(&self) {
            tauri::async_runtime::block_on(self.service.cancel())
        }
    }

    #[test]
    fn a_successful_recording_becomes_a_persisted_voice_capture_and_leaves_no_audio_behind() {
        let h = harness(Ok("  my spoken thought \n"));
        h.start().unwrap();
        assert_eq!(h.recordings().len(), 1, "audio exists while recording");

        let capture = h.stop().unwrap();

        assert_eq!(capture.source, "voice");
        assert_eq!(capture.content, "my spoken thought");
        assert_eq!(Uuid::parse_str(&capture.id).unwrap().get_version_num(), 4);
        assert!(!capture.created_at.is_empty());
        assert_eq!(h.store.list().unwrap(), vec![capture]);
        assert_eq!(h.stt.received.lock().unwrap().as_slice(), b"FAKE-M4A", "the recorded bytes were transcribed");
        assert!(h.recordings().is_empty(), "temporary audio is deleted after transcription");
        h.start().unwrap();
    }

    #[test]
    fn permission_denial_is_reported_cleanly_and_a_later_attempt_works() {
        let h = harness(Ok("hello"));
        *h.recorder.start_error.lock().unwrap() = Some(VoiceError::MicrophonePermissionDenied);

        let error = h.start().unwrap_err();
        assert_eq!(error, VoiceError::MicrophonePermissionDenied);
        assert_eq!(error.code(), "microphone_permission_denied");
        assert!(h.recordings().is_empty());
        assert_eq!(h.stop().unwrap_err(), VoiceError::NotRecording, "no recording was started");

        *h.recorder.start_error.lock().unwrap() = None;
        h.start().unwrap();
        assert_eq!(h.stop().unwrap().content, "hello");
    }

    #[test]
    fn state_transitions_reject_duplicate_start_and_stop_before_start() {
        let h = harness(Ok("hello"));
        assert_eq!(h.stop().unwrap_err(), VoiceError::NotRecording);

        h.start().unwrap();
        assert_eq!(h.start().unwrap_err(), VoiceError::AlreadyRecording);
        assert_eq!(h.recordings().len(), 1, "a rejected duplicate start creates no second file");

        h.stop().unwrap();
        assert_eq!(h.stop().unwrap_err(), VoiceError::NotRecording, "stop twice");
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_network_failure_is_surfaced_deletes_the_audio_stores_nothing_and_can_be_retried() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();

        let error = h.stop().unwrap_err();
        assert_eq!(error.code(), "stt_failed");
        assert!(error.message().contains("Could not reach the speech service"));
        assert!(h.recordings().is_empty(), "audio is deleted after a terminal failure");
        assert!(h.store.list().unwrap().is_empty());

        h.stt.set(Ok("second try works"));
        h.start().unwrap();
        assert_eq!(h.stop().unwrap().content, "second try works");
        assert_eq!(h.store.list().unwrap().len(), 1);
    }

    #[test]
    fn provider_and_credential_failures_have_distinct_safe_messages() {
        for (failure, code, fragment) in [
            (SttError::Auth(401), "stt_failed", "rejected the configured credentials"),
            (SttError::Provider(500), "stt_failed", "HTTP 500"),
            (SttError::Protocol, "stt_failed", "unreadable response"),
            (SttError::NotConfigured, "stt_not_configured", "not configured"),
        ] {
            let h = harness(Err(failure));
            h.start().unwrap();
            let error = h.stop().unwrap_err();
            assert_eq!(error.code(), code);
            assert!(error.message().contains(fragment), "{}", error.message());
            assert!(h.recordings().is_empty());
        }
    }

    #[test]
    fn an_empty_or_blank_transcript_is_rejected_and_nothing_is_stored() {
        for transcript in ["", "   ", "\n\t "] {
            let h = harness(Ok(transcript));
            h.start().unwrap();
            assert_eq!(h.stop().unwrap_err(), VoiceError::EmptyTranscript);
            assert!(h.store.list().unwrap().is_empty());
            assert!(h.recordings().is_empty());
        }
    }

    #[test]
    fn an_interrupted_recording_is_discarded_without_calling_stt() {
        let h = harness(Ok("never used"));
        h.start().unwrap();
        *h.recorder.stop_error.lock().unwrap() = Some(VoiceError::RecordingInterrupted);

        assert_eq!(h.stop().unwrap_err(), VoiceError::RecordingInterrupted);
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 0);
        assert!(h.recordings().is_empty());
        h.start().unwrap();
    }

    #[test]
    fn an_empty_audio_file_fails_safely_without_calling_stt() {
        let mut h = harness(Ok("never used"));
        let recorder = Arc::new(FakeRecorder {
            start_error: Mutex::new(None),
            stop_error: Mutex::new(None),
            audio: Vec::new(),
            active: Mutex::new(None),
            cancelled: AtomicUsize::new(0),
        });
        h.service = VoiceCaptureService::new(recorder, h.stt.clone(), h.dir.path().join("recordings")).unwrap();
        h.start().unwrap();

        assert_eq!(h.stop().unwrap_err(), VoiceError::RecordingFailed);
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 0);
        assert!(h.recordings().is_empty());
    }

    #[test]
    fn a_transcript_the_store_rejects_still_deletes_the_audio() {
        let too_long = "x".repeat(20_001);
        let h = harness(Ok(&too_long));
        h.start().unwrap();

        let error = h.stop().unwrap_err();
        assert_eq!(error.code(), "capture_failed");
        assert!(h.store.list().unwrap().is_empty());
        assert!(h.recordings().is_empty());
    }

    #[test]
    fn cancel_discards_the_recording_without_transcribing_and_is_a_no_op_otherwise() {
        let h = harness(Ok("never used"));
        h.cancel();
        assert_eq!(h.recorder.cancelled.load(Ordering::SeqCst), 0, "nothing to cancel while idle");

        h.start().unwrap();
        h.cancel();
        assert_eq!(h.recorder.cancelled.load(Ordering::SeqCst), 1);
        assert!(h.recordings().is_empty());
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 0);
        assert_eq!(h.stop().unwrap_err(), VoiceError::NotRecording);
        h.start().unwrap();
    }

    #[test]
    fn recordings_left_by_a_previous_run_are_purged_but_other_files_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        fs::create_dir_all(&recordings).unwrap();
        fs::write(recordings.join("arthur-recording-stale.m4a"), b"old audio").unwrap();
        fs::write(recordings.join("unrelated.txt"), b"keep").unwrap();

        VoiceCaptureService::new(FakeRecorder::new(), FakeTranscriber::returning(Ok("x")), recordings.clone()).unwrap();

        assert!(!recordings.join("arthur-recording-stale.m4a").exists());
        assert!(recordings.join("unrelated.txt").exists());
    }

    #[test]
    fn voice_errors_serialize_to_the_contract_shape() {
        let value = serde_json::to_value(VoiceError::MicrophonePermissionDenied).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["code", "message"]);
        assert_eq!(value["code"], "microphone_permission_denied");
    }

    #[test]
    fn the_unsupported_recorder_reports_voice_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let service = VoiceCaptureService::new(
            Arc::new(crate::audio::recorder::UnsupportedRecorder),
            FakeTranscriber::returning(Ok("x")),
            dir.path().join("r"),
        )
        .unwrap();
        assert_eq!(tauri::async_runtime::block_on(service.start()).unwrap_err().code(), "voice_unavailable");
    }
}
