//! Speaking text: chunk, synthesize, play, delete. One session at a time.
//!
//! Lifecycle of a session (`speak`):
//! 1. The text is split into ordered chunks (bounded; see `chunk`). The previous session, if any, is stopped first, so two
//!    answers never play over each other.
//! 2. Chunk 1 is synthesized; while it plays, chunk 2 is already being fetched. Fetching never runs ahead by more than one chunk.
//! 3. Each chunk's audio is written to ONE transient file in the app cache, played, and deleted the moment it ends, fails or is
//!    cancelled. Nothing is kept, indexed or logged, and the files are named by random id, never by content or credential.
//! 4. `stop` bumps the session generation. Every step re-checks the generation, so a stopped session fetches no further chunk and
//!    writes no further file. Files left behind by a crash are removed when the service starts.
//!
//! The status contains no text and no audio, only counts, a coarse state, the outcome and timings.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

use super::chunk::{self, FIRST_CHUNK_CHARS, MAX_CHUNK_CHARS, MAX_TOTAL_CHARS};
use super::player::{AudioPlayer, PlaybackError};
use super::{Speech, Synthesizer, TtsError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechState {
    Idle,
    /// Waiting for the provider, or preparing audio.
    Preparing,
    Playing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechOutcome {
    Finished,
    /// Stopped by the user, by a newer request, or because the system took audio focus.
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechFailure {
    NotConfigured,
    InvalidCredential,
    Unreachable,
    Unsupported,
    SynthesisFailed,
    PlaybackFailed,
    /// This build cannot play audio.
    Unavailable,
}

/// Timings of the FIRST chunk of the latest session: what a person waits for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTimings {
    /// From the request until the provider call began.
    pub startup_ms: u64,
    pub synthesis_ms: u64,
    /// Writing the transient file and preparing the decoder.
    pub preparation_ms: u64,
    /// From the request until audio was audible.
    pub time_to_audible_ms: u64,
    /// Deleting the transient file after it played (set once the first chunk is done).
    pub cleanup_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub state: SpeechState,
    pub session_id: u64,
    pub chunk_index: usize,
    pub chunk_count: usize,
    /// Text beyond the bound was left out of this session.
    pub truncated: bool,
    pub outcome: Option<SpeechOutcome>,
    pub failure: Option<SpeechFailure>,
    pub timings: SpeechTimings,
}

impl SpeechStatus {
    fn idle() -> Self {
        Self { state: SpeechState::Idle, session_id: 0, chunk_index: 0, chunk_count: 0, truncated: false, outcome: None, failure: None, timings: SpeechTimings::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStart {
    pub session_id: u64,
    pub chunk_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SpeechError {
    EmptyText,
    UnsupportedVoiceOrModel,
}

struct State {
    /// Bumped by every `speak` and `stop`. A session whose generation is no longer current does nothing further.
    generation: u64,
    /// Whether some session currently owns the player. The player is one shared device, so a session takes it only once the previous
    /// owner has let go, which makes "wait for THIS playback to end" unambiguous.
    player_held: bool,
    status: SpeechStatus,
}

struct Shared {
    synth: Arc<dyn Synthesizer>,
    player: Arc<dyn AudioPlayer>,
    dir: PathBuf,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct SpeechService(Arc<Shared>);

/// One transient audio file. Deleted when dropped, so every path out of a session (finish, failure, cancellation, panic) cleans up.
struct TempAudio {
    path: PathBuf,
    removed: bool,
}

impl TempAudio {
    fn create(dir: &Path, speech: &Speech) -> std::io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("{}.mp3", uuid::Uuid::new_v4()));
        fs::write(&path, &speech.bytes)?;
        Ok(Self { path, removed: false })
    }

    fn remove(&mut self) {
        let _ = fs::remove_file(&self.path);
        self.removed = true;
    }
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        if !self.removed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Ownership of the player for one chunk's playback. Released on every path out, including cancellation.
struct PlayerHold(SpeechService);

impl Drop for PlayerHold {
    fn drop(&mut self) {
        self.0 .0.state.lock().unwrap_or_else(|p| p.into_inner()).player_held = false;
    }
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

fn failure_of(error: &TtsError) -> SpeechFailure {
    match error {
        TtsError::NotConfigured => SpeechFailure::NotConfigured,
        TtsError::Auth => SpeechFailure::InvalidCredential,
        TtsError::Network => SpeechFailure::Unreachable,
        TtsError::Unsupported => SpeechFailure::Unsupported,
        TtsError::Provider(_) | TtsError::Protocol => SpeechFailure::SynthesisFailed,
    }
}

impl SpeechService {
    /// Removes any audio a previous run left behind (a crash mid-playback), then starts empty.
    pub fn new(synth: Arc<dyn Synthesizer>, player: Arc<dyn AudioPlayer>, dir: PathBuf) -> Self {
        let _ = fs::remove_dir_all(&dir);
        Self(Arc::new(Shared { synth, player, dir, state: Mutex::new(State { generation: 0, player_held: false, status: SpeechStatus::idle() }) }))
    }

    pub fn status(&self) -> SpeechStatus {
        self.0.state.lock().unwrap_or_else(|p| p.into_inner()).status.clone()
    }

    fn is_current(&self, generation: u64) -> bool {
        self.0.state.lock().unwrap_or_else(|p| p.into_inner()).generation == generation
    }

    /// Applies `change` only while `generation` is still the current session.
    fn update(&self, generation: u64, change: impl FnOnce(&mut SpeechStatus)) {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.generation == generation {
            change(&mut state.status);
        }
    }

    fn finish(&self, generation: u64, outcome: SpeechOutcome, failure: Option<SpeechFailure>) {
        self.update(generation, |status| {
            status.state = SpeechState::Idle;
            status.outcome = Some(outcome);
            status.failure = failure;
        });
    }

    /// Starts speaking `text`. Returns as soon as the session is set up; progress and failures are read from `status`.
    pub async fn speak(&self, text: &str, model: String, voice: String) -> Result<SpeechStart, SpeechError> {
        let plan = chunk::plan_with_first(text, FIRST_CHUNK_CHARS, MAX_CHUNK_CHARS, MAX_TOTAL_CHARS);
        if plan.chunks.is_empty() {
            return Err(SpeechError::EmptyText);
        }
        let requested = Instant::now();
        let generation = {
            let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
            state.generation += 1;
            let generation = state.generation;
            state.status = SpeechStatus { state: SpeechState::Preparing, session_id: generation, chunk_index: 0, chunk_count: plan.chunks.len(), truncated: plan.truncated, outcome: None, failure: None, timings: SpeechTimings::default() };
            generation
        };
        // Whatever was playing is silenced before anything new can start.
        self.0.player.stop().await;

        let start = SpeechStart { session_id: generation, chunk_count: plan.chunks.len(), truncated: plan.truncated };
        let service = self.clone();
        tauri::async_runtime::spawn(async move { service.run(generation, plan.chunks, model, voice, requested).await });
        Ok(start)
    }

    pub async fn stop(&self) {
        {
            let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.status.state != SpeechState::Idle {
                state.generation += 1;
                state.status.state = SpeechState::Idle;
                state.status.outcome = Some(SpeechOutcome::Stopped);
                state.status.failure = None;
            }
        }
        self.0.player.stop().await;
    }

    /// Waits for the player to be free. `None` means this session was stopped or replaced while waiting.
    async fn take_player(&self, generation: u64) -> Option<PlayerHold> {
        loop {
            {
                let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
                if state.generation != generation {
                    return None;
                }
                if !state.player_held {
                    state.player_held = true;
                    return Some(PlayerHold(self.clone()));
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    fn fetch(&self, text: String, model: String, voice: String) -> tauri::async_runtime::JoinHandle<Result<Speech, TtsError>> {
        let synth = self.0.synth.clone();
        tauri::async_runtime::spawn(async move { synth.synthesize(&text, &voice, &model).await })
    }

    async fn run(&self, generation: u64, chunks: Vec<String>, model: String, voice: String, requested: Instant) {
        let count = chunks.len();
        let fetch_began = Instant::now();
        let startup_ms = elapsed_ms(requested);
        let mut pending = Some(self.fetch(chunks[0].clone(), model.clone(), voice.clone()));

        for index in 0..count {
            let fetched = match pending.take() {
                Some(handle) => handle.await.unwrap_or(Err(TtsError::Network)),
                None => return,
            };
            // Stopped (or replaced) while the provider was working: nothing further is fetched, written or played.
            if !self.is_current(generation) {
                return;
            }
            let speech = match fetched {
                Ok(speech) => speech,
                Err(error) => return self.finish(generation, SpeechOutcome::Failed, Some(failure_of(&error))),
            };
            if index == 0 {
                let synthesis_ms = elapsed_ms(fetch_began);
                self.update(generation, |s| {
                    s.timings.startup_ms = startup_ms;
                    s.timings.synthesis_ms = synthesis_ms;
                });
            }
            if index + 1 < count {
                pending = Some(self.fetch(chunks[index + 1].clone(), model.clone(), voice.clone()));
            }

            let prepared = Instant::now();
            let mut file = match TempAudio::create(&self.0.dir, &speech) {
                Ok(file) => file,
                Err(_) => return self.abandon(generation, pending, SpeechFailure::PlaybackFailed),
            };
            drop(speech);
            self.update(generation, |s| s.chunk_index = index);

            let Some(_hold) = self.take_player(generation).await else { return abort(pending) };
            match self.0.player.start(&file.path).await {
                Ok(started) => {
                    if !self.is_current(generation) {
                        self.0.player.stop().await;
                        return abort(pending);
                    }
                    let preparation_ms = elapsed_ms(prepared).max(started.prepare_ms);
                    self.update(generation, |s| {
                        s.state = SpeechState::Playing;
                        if index == 0 {
                            s.timings.preparation_ms = preparation_ms;
                            s.timings.time_to_audible_ms = elapsed_ms(requested);
                        }
                    });
                }
                Err(PlaybackError::Cancelled) => return abort(pending),
                Err(PlaybackError::Unavailable) => return self.abandon(generation, pending, SpeechFailure::Unavailable),
                Err(PlaybackError::Failed) => return self.abandon(generation, pending, SpeechFailure::PlaybackFailed),
            }

            match self.0.player.wait().await {
                Ok(()) => {}
                Err(PlaybackError::Cancelled) => {
                    abort(pending);
                    // A stop from the user already recorded itself; the system taking audio focus did not.
                    return self.finish(generation, SpeechOutcome::Stopped, None);
                }
                Err(_) => return self.abandon(generation, pending, SpeechFailure::PlaybackFailed),
            }
            let removing = Instant::now();
            file.remove();
            if index == 0 {
                let cleanup_ms = elapsed_ms(removing);
                self.update(generation, |s| s.timings.cleanup_ms = cleanup_ms);
            }
        }
        self.finish(generation, SpeechOutcome::Finished, None);
    }

    /// A failure after audio work began: stop the prefetch, silence the player, record why.
    fn abandon(&self, generation: u64, pending: Option<tauri::async_runtime::JoinHandle<Result<Speech, TtsError>>>, failure: SpeechFailure) {
        abort(pending);
        self.finish(generation, SpeechOutcome::Failed, Some(failure));
    }
}

fn abort(pending: Option<tauri::async_runtime::JoinHandle<Result<Speech, TtsError>>>) {
    if let Some(handle) = pending {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::async_util::BoxFuture;
    use crate::tts::player::Started;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    /// Scripted provider: answers each call from `script` (then repeats `Ok`), records every request, and can be slowed down.
    struct FakeSynth {
        script: Mutex<VecDeque<Result<Vec<u8>, TtsError>>>,
        calls: Mutex<Vec<(String, String, String)>>,
        delay: Duration,
    }

    impl FakeSynth {
        fn new(script: Vec<Result<Vec<u8>, TtsError>>) -> Arc<Self> {
            Arc::new(Self { script: Mutex::new(script.into()), calls: Mutex::new(Vec::new()), delay: Duration::ZERO })
        }
        fn slow(delay: Duration) -> Arc<Self> {
            Arc::new(Self { script: Mutex::new(VecDeque::new()), calls: Mutex::new(Vec::new()), delay })
        }
        fn texts(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|c| c.0.clone()).collect()
        }
    }

    impl Synthesizer for FakeSynth {
        fn synthesize<'a>(&'a self, text: &'a str, voice: &'a str, model: &'a str) -> BoxFuture<'a, Result<Speech, TtsError>> {
            self.calls.lock().unwrap().push((text.to_string(), voice.to_string(), model.to_string()));
            let next = self.script.lock().unwrap().pop_front();
            let delay = self.delay;
            Box::pin(async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                match next {
                    Some(Err(error)) => Err(error),
                    Some(Ok(bytes)) => Ok(Speech { bytes }),
                    None => Ok(Speech { bytes: b"MP3".to_vec() }),
                }
            })
        }
    }

    /// A player that "plays" until `finish_after` ticks or `stop`, records the files it was given, and checks they exist when played.
    struct FakePlayer {
        started: Mutex<Vec<PathBuf>>,
        existed: Mutex<Vec<bool>>,
        playing: AtomicBool,
        stopped: AtomicBool,
        stops: AtomicUsize,
        fail_start: Option<PlaybackError>,
        hold: bool,
    }

    impl FakePlayer {
        fn new(hold: bool, fail_start: Option<PlaybackError>) -> Arc<Self> {
            Arc::new(Self { started: Mutex::new(vec![]), existed: Mutex::new(vec![]), playing: AtomicBool::new(false), stopped: AtomicBool::new(false), stops: AtomicUsize::new(0), fail_start, hold })
        }
    }

    impl AudioPlayer for FakePlayer {
        fn start<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Started, PlaybackError>> {
            Box::pin(async move {
                if let Some(error) = self.fail_start {
                    return Err(error);
                }
                self.existed.lock().unwrap().push(path.exists());
                self.started.lock().unwrap().push(path.to_path_buf());
                self.stopped.store(false, Ordering::SeqCst);
                self.playing.store(true, Ordering::SeqCst);
                Ok(Started { prepare_ms: 3 })
            })
        }
        fn wait<'a>(&'a self) -> BoxFuture<'a, Result<(), PlaybackError>> {
            Box::pin(async move {
                let mut ticks = 0;
                loop {
                    if self.stopped.load(Ordering::SeqCst) {
                        self.playing.store(false, Ordering::SeqCst);
                        return Err(PlaybackError::Cancelled);
                    }
                    if !self.hold && ticks >= 2 {
                        self.playing.store(false, Ordering::SeqCst);
                        return Ok(());
                    }
                    ticks += 1;
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
        }
        fn stop<'a>(&'a self) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.stops.fetch_add(1, Ordering::SeqCst);
                self.stopped.store(true, Ordering::SeqCst);
            })
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    fn pause(ms: u64) {
        run(async move { tokio::time::sleep(Duration::from_millis(ms)).await });
    }

    fn until_idle(service: &SpeechService) -> SpeechStatus {
        for _ in 0..400 {
            let status = service.status();
            if status.state == SpeechState::Idle && status.outcome.is_some() {
                return status;
            }
            pause(5);
        }
        panic!("the session never finished: {:?}", service.status());
    }

    fn until_playing(service: &SpeechService) {
        for _ in 0..400 {
            if service.status().state == SpeechState::Playing {
                return;
            }
            pause(5);
        }
        panic!("never started playing: {:?}", service.status());
    }

    fn files(dir: &Path) -> usize {
        fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
    }

    fn speak(service: &SpeechService, text: &str) -> SpeechStart {
        run(service.speak(text, "gpt-4o-mini-tts".into(), "alloy".into())).unwrap()
    }

    fn fixture(synth: Arc<FakeSynth>, player: Arc<FakePlayer>) -> (SpeechService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (SpeechService::new(synth, player, dir.path().join("tts")), dir)
    }

    #[test]
    fn speaking_synthesizes_plays_from_a_transient_file_and_leaves_nothing_behind() {
        let synth = FakeSynth::new(vec![]);
        let player = FakePlayer::new(false, None);
        let (service, dir) = fixture(synth.clone(), player.clone());
        let start = speak(&service, "Hello, I'm Arthur.");
        assert_eq!((start.chunk_count, start.truncated), (1, false));
        let status = until_idle(&service);
        assert_eq!((status.outcome, status.failure), (Some(SpeechOutcome::Finished), None));
        assert_eq!(*player.existed.lock().unwrap(), vec![true], "the audio file existed while it played");
        assert_eq!(files(&dir.path().join("tts")), 0, "and was deleted right after");
        assert!(status.timings.time_to_audible_ms >= status.timings.synthesis_ms);
        assert_eq!(synth.calls.lock().unwrap()[0].1, "alloy");
    }

    #[test]
    fn english_and_bulgarian_text_reach_the_provider_exactly_as_written() {
        for text in ["Short English.", "Здравей, това е Arthur. Как си днес?", "Punctuation: «кавички», (скоби), 3.5 — тире…"] {
            let synth = FakeSynth::new(vec![]);
            let (service, _dir) = fixture(synth.clone(), FakePlayer::new(false, None));
            speak(&service, text);
            until_idle(&service);
            assert_eq!(synth.texts().join(" "), text);
        }
    }

    #[test]
    fn a_long_answer_is_chunked_in_order_with_one_chunk_fetched_ahead() {
        let text = "This is a fairly ordinary sentence for the long answer test. ".repeat(60);
        let synth = FakeSynth::new(vec![]);
        let player = FakePlayer::new(false, None);
        let (service, dir) = fixture(synth.clone(), player.clone());
        let start = speak(&service, text.trim());
        assert!(start.chunk_count >= 4, "{}", start.chunk_count);
        let status = until_idle(&service);
        assert_eq!(status.outcome, Some(SpeechOutcome::Finished));
        assert_eq!(synth.texts().join(" "), text.trim(), "order preserved, nothing lost");
        assert_eq!(player.started.lock().unwrap().len(), start.chunk_count);
        assert_eq!(files(&dir.path().join("tts")), 0);
    }

    #[test]
    fn text_beyond_the_bound_is_left_out_and_reported() {
        let text = "Another sentence of the same size. ".repeat(400);
        let (service, _dir) = fixture(FakeSynth::new(vec![]), FakePlayer::new(false, None));
        let start = speak(&service, &text);
        assert!(start.truncated);
        until_idle(&service);
        assert!(service.status().truncated);
    }

    #[test]
    fn empty_text_is_refused_without_a_request() {
        let synth = FakeSynth::new(vec![]);
        let (service, _dir) = fixture(synth.clone(), FakePlayer::new(false, None));
        assert_eq!(run(service.speak("  \n ", "m".into(), "v".into())), Err(SpeechError::EmptyText));
        assert!(synth.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn each_provider_failure_is_a_distinct_bounded_state() {
        for (error, expected) in [
            (TtsError::NotConfigured, SpeechFailure::NotConfigured),
            (TtsError::Auth, SpeechFailure::InvalidCredential),
            (TtsError::Network, SpeechFailure::Unreachable),
            (TtsError::Unsupported, SpeechFailure::Unsupported),
            (TtsError::Provider(500), SpeechFailure::SynthesisFailed),
            (TtsError::Protocol, SpeechFailure::SynthesisFailed),
        ] {
            let player = FakePlayer::new(false, None);
            let (service, dir) = fixture(FakeSynth::new(vec![Err(error)]), player.clone());
            speak(&service, "Hello.");
            let status = until_idle(&service);
            assert_eq!((status.outcome, status.failure), (Some(SpeechOutcome::Failed), Some(expected)));
            assert!(player.started.lock().unwrap().is_empty(), "nothing was played");
            assert_eq!(files(&dir.path().join("tts")), 0);
        }
    }

    #[test]
    fn a_playback_failure_and_an_unavailable_player_are_reported_and_clean_up() {
        for (error, expected) in [(PlaybackError::Failed, SpeechFailure::PlaybackFailed), (PlaybackError::Unavailable, SpeechFailure::Unavailable)] {
            let (service, dir) = fixture(FakeSynth::new(vec![]), FakePlayer::new(false, Some(error)));
            speak(&service, "Hello.");
            let status = until_idle(&service);
            assert_eq!((status.outcome, status.failure), (Some(SpeechOutcome::Failed), Some(expected)));
            assert_eq!(files(&dir.path().join("tts")), 0, "the file written for playback was deleted");
        }
    }

    #[test]
    fn a_failure_in_a_later_chunk_stops_the_session_cleanly() {
        let text = "A sentence that is long enough to be its own chunk in this test, repeated. ".repeat(30);
        let player = FakePlayer::new(false, None);
        let (service, dir) = fixture(FakeSynth::new(vec![Ok(b"a".to_vec()), Err(TtsError::Network)]), player.clone());
        speak(&service, text.trim());
        let status = until_idle(&service);
        assert_eq!((status.outcome, status.failure), (Some(SpeechOutcome::Failed), Some(SpeechFailure::Unreachable)));
        assert_eq!(player.started.lock().unwrap().len(), 1);
        assert_eq!(files(&dir.path().join("tts")), 0);
    }

    #[test]
    fn stop_cancels_playback_fetches_no_further_chunk_and_deletes_the_audio() {
        let text = "A sentence that is long enough to be its own chunk in this test, repeated. ".repeat(60);
        let synth = FakeSynth::new(vec![]);
        let player = FakePlayer::new(true, None);
        let (service, dir) = fixture(synth.clone(), player.clone());
        let start = speak(&service, text.trim());
        until_playing(&service);
        assert_eq!(files(&dir.path().join("tts")), 1, "exactly the chunk being played exists");
        let before = synth.calls.lock().unwrap().len();
        assert!(before <= 2, "at most the playing chunk and one prefetched: {before}");

        run(service.stop());
        let status = service.status();
        assert_eq!((status.state, status.outcome), (SpeechState::Idle, Some(SpeechOutcome::Stopped)));
        pause(80);
        assert_eq!(synth.calls.lock().unwrap().len(), before, "no new chunk was requested after stop");
        assert_eq!(player.started.lock().unwrap().len(), 1, "and no further chunk was played");
        assert_eq!(files(&dir.path().join("tts")), 0);
        assert!(start.chunk_count > 2);
    }

    #[test]
    fn stopping_while_the_provider_is_still_working_plays_nothing() {
        let player = FakePlayer::new(false, None);
        let (service, dir) = fixture(FakeSynth::slow(Duration::from_millis(60)), player.clone());
        speak(&service, "Hello.");
        run(service.stop());
        pause(150);
        assert!(player.started.lock().unwrap().is_empty());
        assert_eq!(files(&dir.path().join("tts")), 0);
        assert_eq!(service.status().outcome, Some(SpeechOutcome::Stopped));
    }

    #[test]
    fn repeated_playback_replaces_the_previous_session_and_never_overlaps() {
        let player = FakePlayer::new(true, None);
        let (service, dir) = fixture(FakeSynth::new(vec![]), player.clone());
        let first = speak(&service, "First answer.");
        until_playing(&service);
        let second = speak(&service, "Second answer.");
        assert!(second.session_id > first.session_id);
        assert!(player.stops.load(Ordering::SeqCst) >= 1, "the old audio was silenced before the new one");
        for _ in 0..400 {
            if player.started.lock().unwrap().len() == 2 && service.status().state == SpeechState::Playing {
                break;
            }
            pause(5);
        }
        assert_eq!(service.status().session_id, second.session_id);
        assert_eq!(files(&dir.path().join("tts")), 1, "only the current session's audio exists");
        run(service.stop());
        pause(40);
        assert_eq!(files(&dir.path().join("tts")), 0);
    }

    #[test]
    fn the_system_taking_audio_focus_ends_the_session_as_stopped_not_failed() {
        let player = FakePlayer::new(true, None);
        let (service, dir) = fixture(FakeSynth::new(vec![]), player.clone());
        speak(&service, "Hello.");
        until_playing(&service);
        // The player reports cancellation on its own (focus lost), without the user pressing stop.
        player.stopped.store(true, Ordering::SeqCst);
        let status = until_idle(&service);
        assert_eq!((status.outcome, status.failure), (Some(SpeechOutcome::Stopped), None));
        assert_eq!(files(&dir.path().join("tts")), 0);
    }

    #[test]
    fn abandoned_audio_from_a_crashed_run_is_removed_when_the_service_starts() {
        let dir = tempfile::tempdir().unwrap();
        let tts = dir.path().join("tts");
        fs::create_dir_all(&tts).unwrap();
        fs::write(tts.join("left-behind.mp3"), b"old").unwrap();
        let _service = SpeechService::new(FakeSynth::new(vec![]), FakePlayer::new(false, None), tts.clone());
        assert_eq!(files(&tts), 0);
    }

    #[test]
    fn the_status_carries_no_text_audio_or_credential() {
        let (service, _dir) = fixture(FakeSynth::new(vec![]), FakePlayer::new(false, None));
        speak(&service, "Top secret sentence about Ignatov.");
        until_idle(&service);
        let json = serde_json::to_string(&service.status()).unwrap();
        assert!(!json.contains("Ignatov") && !json.contains("secret") && !json.contains("mp3"), "{json}");
    }
}
