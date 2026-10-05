use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::storage::capture_store::{Capture, CaptureStore, CreateCaptureInput};
use crate::stt::{SttError, Transcriber};

use super::error::VoiceError;
use super::recorder::{MicrophonePermission, Recorder};

const FILE_PREFIX: &str = "arthur-recording-";
const FILE_EXTENSION: &str = "m4a";
/// Stay under the provider's 25 MB upload limit.
pub const MAX_RECORDING_BYTES: u64 = 24 * 1024 * 1024;
/// How long a recording whose transcription failed (and may pass) is kept so it can be retried. A safety limit, not a
/// feature: the audio is deleted much sooner by a successful retry, a discard, or the user leaving the retry screen.
pub const RETRY_TTL: Duration = Duration::from_secs(15 * 60);

/// The sentence every retryable failure ends with, so the user is told exactly what is kept and for how long.
pub fn retry_note() -> String {
    format!("Your recording is kept for up to {} minutes so you can try again without speaking again.", RETRY_TTL.as_secs() / 60)
}

/// A transcription failure that may pass: no connection, a busy or overloaded provider. Everything else is final
/// (rejected credentials, no key, a malformed answer, a request the provider refuses), so keeping the audio would
/// only keep it for nothing.
fn is_retryable(cause: &SttError) -> bool {
    match cause {
        SttError::Network => true,
        SttError::Provider(status) => matches!(*status, 408 | 425 | 429 | 500..=599),
        SttError::NotConfigured | SttError::Auth(_) | SttError::Protocol => false,
    }
}

/// A kept recording. `deadline` is fixed when the first attempt fails and is never extended by retries.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Kept {
    path: PathBuf,
    token: u64,
    deadline: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Idle,
    Starting,
    Recording(PathBuf),
    Transcribing,
    /// Transcription failed in a retryable way; the audio is kept for `retry`/`discard`/expiry.
    Retryable(Kept),
}

struct Shared {
    state: Mutex<State>,
}

type SharedState = Arc<Shared>;

fn lock(shared: &SharedState) -> MutexGuard<'_, State> {
    // A panic elsewhere must not wedge voice capture forever.
    shared.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Deletes the recording and returns the service to `Idle` when dropped, on every exit path (success, error, early
/// return), unless the recording was deliberately kept for a retry.
struct RecordingGuard {
    path: PathBuf,
    shared: SharedState,
    armed: bool,
}

impl RecordingGuard {
    fn new(path: PathBuf, shared: SharedState) -> Self {
        Self { path, shared, armed: true }
    }
    /// The recording stays on disk; the caller has put the service into a state that owns it.
    fn keep(mut self) {
        self.armed = false;
    }
}

impl Drop for RecordingGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
            *lock(&self.shared) = State::Idle;
        }
    }
}

pub struct VoiceCaptureService {
    recorder: Arc<dyn Recorder>,
    transcriber: Arc<dyn Transcriber>,
    recordings_dir: PathBuf,
    shared: SharedState,
    retry_ttl: Duration,
    next_token: AtomicU64,
}

impl VoiceCaptureService {
    /// Creates the recordings directory and purges recordings a previous run
    /// left behind (for example after a crash, or a retry that was still open when the app died).
    pub fn new(recorder: Arc<dyn Recorder>, transcriber: Arc<dyn Transcriber>, recordings_dir: PathBuf) -> std::io::Result<Self> {
        Self::with_retry_ttl(recorder, transcriber, recordings_dir, RETRY_TTL)
    }

    pub fn with_retry_ttl(recorder: Arc<dyn Recorder>, transcriber: Arc<dyn Transcriber>, recordings_dir: PathBuf, retry_ttl: Duration) -> std::io::Result<Self> {
        fs::create_dir_all(&recordings_dir)?;
        purge_stale_recordings(&recordings_dir);
        Ok(Self { recorder, transcriber, recordings_dir, shared: Arc::new(Shared { state: Mutex::new(State::Idle) }), retry_ttl, next_token: AtomicU64::new(1) })
    }

    pub async fn start(&self) -> Result<(), VoiceError> {
        {
            let mut state = lock(&self.shared);
            match &*state {
                // Starting over leaves the retry flow: the kept recording is deleted before anything new is recorded.
                State::Retryable(kept) => {
                    let _ = fs::remove_file(&kept.path);
                }
                State::Idle => {}
                _ => return Err(VoiceError::AlreadyRecording),
            }
            *state = State::Starting;
        }

        let path = self.recordings_dir.join(format!("{FILE_PREFIX}{}.{FILE_EXTENSION}", Uuid::new_v4()));
        match self.recorder.start(&path).await {
            Ok(()) => {
                *lock(&self.shared) = State::Recording(path);
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(&path);
                *lock(&self.shared) = State::Idle;
                Err(error)
            }
        }
    }

    /// Stops recording, transcribes, and persists the transcript as a voice Capture.
    ///
    /// If the transcription fails in a way that may pass, the recording is kept (see `retry`) and the error says so.
    pub async fn stop(&self, store: &CaptureStore) -> Result<Capture, VoiceError> {
        let path = {
            let mut state = lock(&self.shared);
            match &*state {
                State::Recording(path) => {
                    let path = path.clone();
                    *state = State::Transcribing;
                    path
                }
                _ => return Err(VoiceError::NotRecording),
            }
        };
        // From here on the audio file is deleted and the state reset, unless it is kept for a retry.
        let guard = RecordingGuard::new(path.clone(), self.shared.clone());

        self.recorder.stop().await?;
        self.transcribe(guard, store, None).await
    }

    /// Transcribes the SAME kept recording again. A Capture is created only when the transcription succeeds, and the
    /// audio is deleted then. A failure that may pass keeps the recording (until its original deadline); a final one
    /// deletes it.
    pub async fn retry(&self, store: &CaptureStore) -> Result<Capture, VoiceError> {
        let kept = {
            let mut state = lock(&self.shared);
            match &*state {
                State::Retryable(kept) if Instant::now() < kept.deadline => {
                    let kept = kept.clone();
                    *state = State::Transcribing;
                    kept
                }
                State::Retryable(kept) => {
                    // Expired before its timer ran.
                    let _ = fs::remove_file(&kept.path);
                    *state = State::Idle;
                    return Err(VoiceError::NoRetainedRecording);
                }
                _ => return Err(VoiceError::NoRetainedRecording),
            }
        };
        let guard = RecordingGuard::new(kept.path.clone(), self.shared.clone());
        self.transcribe(guard, store, Some(kept)).await
    }

    /// Deletes a kept recording. A no-op when there is none.
    pub fn discard(&self) {
        let mut state = lock(&self.shared);
        if let State::Retryable(kept) = &*state {
            let _ = fs::remove_file(&kept.path);
            *state = State::Idle;
        }
    }

    async fn transcribe(&self, guard: RecordingGuard, store: &CaptureStore, retry_of: Option<Kept>) -> Result<Capture, VoiceError> {
        let audio = read_audio(&guard.path)?;
        let file_name = guard.path.file_name().and_then(|n| n.to_str()).unwrap_or("recording.m4a").to_string();

        let transcript = match self.transcriber.transcribe(&audio, &file_name).await {
            Ok(text) => text,
            Err(cause) if is_retryable(&cause) => return self.keep_for_retry(guard, cause, retry_of),
            Err(cause) => return Err(VoiceError::from(cause)),
        };
        let transcript = transcript.trim();
        if transcript.is_empty() {
            return Err(VoiceError::EmptyTranscript);
        }

        store
            .create(CreateCaptureInput { source: "voice".into(), content: transcript.to_string() })
            .map_err(|error| VoiceError::CaptureFailed(error.to_string()))
    }

    fn keep_for_retry(&self, guard: RecordingGuard, cause: SttError, retry_of: Option<Kept>) -> Result<Capture, VoiceError> {
        let (token, deadline, first) = match retry_of {
            Some(kept) => (kept.token, kept.deadline, false),
            None => (self.next_token.fetch_add(1, Ordering::SeqCst), Instant::now() + self.retry_ttl, true),
        };
        if Instant::now() >= deadline {
            // The time ran out while the retry was in flight: the audio goes (the guard deletes it).
            return Err(VoiceError::from(cause));
        }
        *lock(&self.shared) = State::Retryable(Kept { path: guard.path.clone(), token, deadline });
        guard.keep();
        if first {
            self.expire_later(token, deadline);
        }
        Err(VoiceError::SttRetryable(cause))
    }

    /// Deletes the kept recording when its deadline passes, even if nobody asks for it again.
    fn expire_later(&self, token: u64, deadline: Instant) {
        let shared = self.shared.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            let mut state = lock(&shared);
            // Only the recording this timer was set for, and only while it is waiting: a retry in flight is judged
            // by `keep_for_retry` when it finishes.
            if matches!(&*state, State::Retryable(kept) if kept.token == token) {
                if let State::Retryable(kept) = &*state {
                    let _ = fs::remove_file(&kept.path);
                }
                *state = State::Idle;
            }
        });
    }

    /// Discards an in-progress recording without transcribing it. A no-op in any other state.
    pub async fn cancel(&self) {
        let path = {
            let state = lock(&self.shared);
            match &*state {
                State::Recording(path) => path.clone(),
                _ => return,
            }
        };
        self.recorder.cancel().await;
        let _ = fs::remove_file(&path);
        *lock(&self.shared) = State::Idle;
    }

    /// The microphone permission, read without asking.
    pub async fn microphone_permission(&self) -> Result<MicrophonePermission, VoiceError> {
        self.recorder.permission().await
    }

    pub async fn open_app_settings(&self) -> Result<(), VoiceError> {
        self.recorder.open_settings().await
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
        starts: AtomicUsize,
        permission: Mutex<MicrophonePermission>,
        settings_opened: AtomicUsize,
    }

    impl FakeRecorder {
        fn new() -> Arc<Self> {
            Self::with_audio(b"FAKE-M4A".to_vec())
        }
        fn with_audio(audio: Vec<u8>) -> Arc<Self> {
            Arc::new(Self {
                start_error: Mutex::new(None),
                stop_error: Mutex::new(None),
                audio,
                active: Mutex::new(None),
                cancelled: AtomicUsize::new(0),
                starts: AtomicUsize::new(0),
                permission: Mutex::new(MicrophonePermission::Unknown),
                settings_opened: AtomicUsize::new(0),
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
                self.starts.fetch_add(1, Ordering::SeqCst);
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

        fn permission<'a>(&'a self) -> BoxFuture<'a, Result<MicrophonePermission, VoiceError>> {
            Box::pin(async move { Ok(*self.permission.lock().unwrap()) })
        }

        fn open_settings<'a>(&'a self) -> BoxFuture<'a, Result<(), VoiceError>> {
            Box::pin(async move {
                self.settings_opened.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    struct FakeTranscriber {
        result: Mutex<Result<String, SttError>>,
        calls: AtomicUsize,
        received: Mutex<Vec<u8>>,
        names: Mutex<Vec<String>>,
    }

    impl FakeTranscriber {
        fn returning(result: Result<&str, SttError>) -> Arc<Self> {
            Arc::new(Self {
                result: Mutex::new(result.map(String::from)),
                calls: AtomicUsize::new(0),
                received: Mutex::new(Vec::new()),
                names: Mutex::new(Vec::new()),
            })
        }
        fn set(&self, result: Result<&str, SttError>) {
            *self.result.lock().unwrap() = result.map(String::from);
        }
    }

    impl Transcriber for FakeTranscriber {
        fn transcribe<'a>(&'a self, audio: &'a [u8], file_name: &'a str) -> BoxFuture<'a, Result<String, SttError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                *self.received.lock().unwrap() = audio.to_vec();
                self.names.lock().unwrap().push(file_name.to_string());
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
        harness_with_ttl(stt_result, RETRY_TTL)
    }

    fn harness_with_ttl(stt_result: Result<&str, SttError>, ttl: Duration) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let recorder = FakeRecorder::new();
        let stt = FakeTranscriber::returning(stt_result);
        let service = VoiceCaptureService::with_retry_ttl(recorder.clone(), stt.clone(), dir.path().join("recordings"), ttl).unwrap();
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
        fn retry(&self) -> Result<Capture, VoiceError> {
            tauri::async_runtime::block_on(self.service.retry(&self.store))
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
    fn a_retryable_failure_keeps_the_audio_stores_no_capture_and_says_so() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();

        let error = h.stop().unwrap_err();

        assert_eq!(error.code(), "stt_retryable");
        assert!(error.message().contains("Could not reach the speech service"));
        assert!(error.message().contains("kept for up to 15 minutes"), "{}", error.message());
        assert_eq!(h.recordings().len(), 1, "the recording is kept for the retry");
        assert!(h.store.list().unwrap().is_empty(), "a Capture exists only after a successful transcription");
        assert!(matches!(&*lock(&h.service.shared), State::Retryable(_)));
    }

    #[test]
    fn retrying_transcribes_the_same_recording_without_recording_again_then_saves_one_capture_and_deletes_the_audio() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();
        h.stop().unwrap_err();
        let kept = h.recordings();

        h.stt.set(Ok(" what I said "));
        let capture = h.retry().unwrap();

        assert_eq!((capture.source.as_str(), capture.content.as_str()), ("voice", "what I said"));
        assert_eq!(h.recorder.starts.load(Ordering::SeqCst), 1, "nobody spoke again");
        let names = h.stt.names.lock().unwrap().clone();
        assert_eq!(names.len(), 2);
        assert_eq!(names[0], names[1], "the very same file was sent both times");
        assert_eq!(kept, vec![names[0].clone()]);
        assert_eq!(h.stt.received.lock().unwrap().as_slice(), b"FAKE-M4A");
        assert_eq!(h.store.list().unwrap(), vec![capture], "exactly one Capture");
        assert!(h.recordings().is_empty(), "the audio is deleted once it has been transcribed");
        h.start().unwrap();
    }

    #[test]
    fn a_retry_that_fails_again_keeps_the_recording_without_extending_its_deadline() {
        let h = harness(Err(SttError::Provider(503)));
        h.start().unwrap();
        assert_eq!(h.stop().unwrap_err().code(), "stt_retryable");
        let first = match &*lock(&h.service.shared) {
            State::Retryable(kept) => kept.clone(),
            other => panic!("{other:?}"),
        };

        assert_eq!(h.retry().unwrap_err().code(), "stt_retryable");
        assert_eq!(h.retry().unwrap_err().code(), "stt_retryable");

        match &*lock(&h.service.shared) {
            State::Retryable(kept) => assert_eq!(kept, &first, "same file, same token, same deadline"),
            other => panic!("{other:?}"),
        }
        assert_eq!(h.recordings().len(), 1);
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_retry_that_hits_a_final_failure_deletes_the_audio() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();
        h.stop().unwrap_err();
        h.stt.set(Err(SttError::Auth(401)));

        assert_eq!(h.retry().unwrap_err().code(), "stt_failed");

        assert!(h.recordings().is_empty());
        assert_eq!(h.retry().unwrap_err(), VoiceError::NoRetainedRecording);
    }

    #[test]
    fn an_empty_transcript_on_retry_is_final_and_deletes_the_audio() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();
        h.stop().unwrap_err();
        h.stt.set(Ok("   "));

        assert_eq!(h.retry().unwrap_err(), VoiceError::EmptyTranscript);

        assert!(h.recordings().is_empty());
        assert!(h.store.list().unwrap().is_empty());
    }

    #[test]
    fn discarding_deletes_the_kept_audio_and_a_later_retry_has_nothing_to_retry() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();
        h.stop().unwrap_err();

        h.service.discard();

        assert!(h.recordings().is_empty());
        assert_eq!(h.retry().unwrap_err(), VoiceError::NoRetainedRecording);
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 1, "no second upload");
        h.service.discard(); // a no-op, not an error
        h.start().unwrap();
    }

    #[test]
    fn starting_a_new_recording_leaves_the_retry_flow_and_deletes_the_kept_audio_first() {
        let h = harness(Err(SttError::Network));
        h.start().unwrap();
        h.stop().unwrap_err();
        let kept = h.recordings();

        h.start().unwrap();

        let now = h.recordings();
        assert_eq!(now.len(), 1, "only the new recording exists");
        assert_ne!(now, kept, "the old one is gone");
        assert_eq!(h.retry().unwrap_err(), VoiceError::NoRetainedRecording);
    }

    #[test]
    fn the_kept_audio_is_deleted_when_its_time_runs_out_even_if_nobody_asks() {
        let h = harness_with_ttl(Err(SttError::Network), Duration::from_millis(120));
        h.start().unwrap();
        h.stop().unwrap_err();
        assert_eq!(h.recordings().len(), 1);

        std::thread::sleep(Duration::from_millis(600));

        assert!(h.recordings().is_empty(), "the deadline deleted it");
        assert_eq!(*lock(&h.service.shared), State::Idle);
        assert_eq!(h.retry().unwrap_err(), VoiceError::NoRetainedRecording);
    }

    #[test]
    fn a_retry_asked_for_after_the_deadline_deletes_instead_of_uploading() {
        let h = harness_with_ttl(Err(SttError::Network), Duration::from_millis(1));
        h.start().unwrap();
        h.stop().unwrap_err();
        std::thread::sleep(Duration::from_millis(30));
        // Whichever ran first, the timer or this call, the audio is gone and nothing was uploaded again.
        assert_eq!(h.retry().unwrap_err(), VoiceError::NoRetainedRecording);
        assert!(h.recordings().is_empty());
        assert_eq!(h.stt.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_new_recording_is_not_expired_by_the_timer_of_an_older_one() {
        let h = harness_with_ttl(Err(SttError::Network), Duration::from_millis(150));
        h.start().unwrap();
        h.stop().unwrap_err();
        h.start().unwrap(); // leaves the retry flow, starts recording again
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(h.recordings().len(), 1, "the live recording survives the old timer");
        assert!(matches!(&*lock(&h.service.shared), State::Recording(_)));
    }

    #[test]
    fn only_failures_that_may_pass_keep_the_audio() {
        for (failure, kept) in [
            (SttError::Network, true),
            (SttError::Provider(500), true),
            (SttError::Provider(503), true),
            (SttError::Provider(429), true),
            (SttError::Provider(408), true),
            (SttError::Provider(400), false),
            (SttError::Provider(413), false),
            (SttError::Auth(401), false),
            (SttError::Auth(403), false),
            (SttError::Protocol, false),
            (SttError::NotConfigured, false),
        ] {
            let h = harness(Err(failure.clone()));
            h.start().unwrap();
            let error = h.stop().unwrap_err();
            assert_eq!(error.code() == "stt_retryable", kept, "{failure:?}");
            assert_eq!(h.recordings().len(), usize::from(kept), "{failure:?}");
            assert!(h.store.list().unwrap().is_empty());
        }
    }

    #[test]
    fn leftover_kept_audio_from_a_run_that_died_is_purged_at_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let recordings = dir.path().join("recordings");
        {
            let h = VoiceCaptureService::new(FakeRecorder::new(), FakeTranscriber::returning(Err(SttError::Network)), recordings.clone()).unwrap();
            tauri::async_runtime::block_on(h.start()).unwrap();
            tauri::async_runtime::block_on(h.stop(&CaptureStore::open_in_memory().unwrap())).unwrap_err();
            assert_eq!(fs::read_dir(&recordings).unwrap().count(), 1, "kept for a retry that never happened");
        } // the app dies: nothing deletes it
        VoiceCaptureService::new(FakeRecorder::new(), FakeTranscriber::returning(Ok("x")), recordings.clone()).unwrap();
        assert_eq!(fs::read_dir(&recordings).unwrap().count(), 0);
    }

    #[test]
    fn the_permission_is_read_without_starting_anything_and_settings_can_be_opened() {
        let h = harness(Ok("x"));
        for expected in [MicrophonePermission::Unknown, MicrophonePermission::Granted, MicrophonePermission::Denied, MicrophonePermission::DeniedPermanently] {
            *h.recorder.permission.lock().unwrap() = expected;
            assert_eq!(tauri::async_runtime::block_on(h.service.microphone_permission()).unwrap(), expected);
        }
        assert_eq!(h.recorder.starts.load(Ordering::SeqCst), 0, "reading the permission never records");
        assert!(h.recordings().is_empty());
        tauri::async_runtime::block_on(h.service.open_app_settings()).unwrap();
        assert_eq!(h.recorder.settings_opened.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn permission_states_serialize_as_the_contract_words() {
        let words: Vec<String> = [MicrophonePermission::Unknown, MicrophonePermission::Granted, MicrophonePermission::Denied, MicrophonePermission::DeniedPermanently]
            .iter()
            .map(|state| serde_json::to_value(state).unwrap().as_str().unwrap().to_string())
            .collect();
        assert_eq!(words, ["unknown", "granted", "denied", "denied_permanently"]);
    }

    #[test]
    fn provider_and_credential_failures_have_distinct_safe_messages() {
        for (failure, code, fragment) in [
            (SttError::Auth(401), "stt_failed", "rejected the configured credentials"),
            (SttError::Provider(400), "stt_failed", "HTTP 400"),
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
        let recorder = FakeRecorder::with_audio(Vec::new());
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
