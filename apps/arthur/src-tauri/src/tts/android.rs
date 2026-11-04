//! Android playback: a thin bridge to the Kotlin `PlaybackPlugin`
//! (`gen/android/app/src/main/java/dev/kaloyan/arthur/PlaybackPlugin.kt`). It carries a file path and nothing else: no text, no
//! credential, no provider detail.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

use crate::async_util::BoxFuture;

use super::player::{AudioPlayer, PlaybackError, Started};

const PLUGIN_IDENTIFIER: &str = "dev.kaloyan.arthur";
const PLUGIN_CLASS: &str = "PlaybackPlugin";

pub struct AndroidPlayer {
    handle: PluginHandle<Wry>,
}

#[derive(Serialize)]
struct PlayArgs<'a> {
    path: &'a str,
}

#[derive(Deserialize)]
struct StartedPayload {
    #[serde(rename = "prepareMs")]
    prepare_ms: u64,
}

#[derive(Deserialize)]
struct EndedPayload {
    cancelled: bool,
}

impl AudioPlayer for AndroidPlayer {
    fn start<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<Started, PlaybackError>> {
        Box::pin(async move {
            let path = path.to_str().ok_or(PlaybackError::Failed)?;
            let started = self
                .handle
                .run_mobile_plugin_async::<StartedPayload>("startPlayback", PlayArgs { path })
                .await
                .map_err(|_| PlaybackError::Failed)?;
            Ok(Started {
                prepare_ms: started.prepare_ms,
            })
        })
    }

    fn wait<'a>(&'a self) -> BoxFuture<'a, Result<(), PlaybackError>> {
        Box::pin(async move {
            match self
                .handle
                .run_mobile_plugin_async::<EndedPayload>("awaitPlayback", ())
                .await
            {
                Ok(ended) if ended.cancelled => Err(PlaybackError::Cancelled),
                Ok(_) => Ok(()),
                Err(_) => Err(PlaybackError::Failed),
            }
        })
    }

    fn stop<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self
                .handle
                .run_mobile_plugin_async::<serde_json::Value>("stopPlayback", ())
                .await;
        })
    }
}

/// Registers the Kotlin plugin and makes the player available as managed state.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("arthur-playback")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
            app.manage(Arc::new(AndroidPlayer { handle }));
            Ok(())
        })
        .build()
}
