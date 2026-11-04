//! Playback of one transient audio file. The platform supplies the implementation; the service never touches the OS audio stack.

use std::path::Path;

use crate::async_util::BoxFuture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackError {
    /// This build has no audio output (desktop development builds).
    Unavailable,
    /// The audio could not be prepared or played. (Only the Android player reports it; desktop builds have no player.)
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Failed,
    /// Playback was stopped: by the user, by a newer request, or by the system taking audio focus away.
    Cancelled,
}

/// What starting playback cost, for the performance record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Started {
    /// Decoder preparation, until audio was audible.
    pub prepare_ms: u64,
}

pub trait AudioPlayer: Send + Sync {
    /// Prepares the file and begins playing. Resolves when audio is audible.
    fn start<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Started, PlaybackError>>;
    /// Resolves when the playing audio ends (`Ok`) or is stopped (`Err(Cancelled)`).
    fn wait<'a>(&'a self) -> BoxFuture<'a, Result<(), PlaybackError>>;
    /// Stops whatever is playing, releases it and gives up audio focus. Safe to call when nothing is playing.
    fn stop<'a>(&'a self) -> BoxFuture<'a, ()>;
}

pub struct UnavailablePlayer;

impl AudioPlayer for UnavailablePlayer {
    fn start<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<Started, PlaybackError>> {
        Box::pin(async { Err(PlaybackError::Unavailable) })
    }
    fn wait<'a>(&'a self) -> BoxFuture<'a, Result<(), PlaybackError>> {
        Box::pin(async { Err(PlaybackError::Cancelled) })
    }
    fn stop<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}
