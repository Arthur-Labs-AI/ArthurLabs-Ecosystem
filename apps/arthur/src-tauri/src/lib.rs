mod async_util;
mod audio;
mod commands;
mod distillation;
mod platform;
mod providers;
mod storage;
mod stt;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use audio::recorder::Recorder;
use audio::voice_capture::VoiceCaptureService;
use distillation::openai::OpenAiDistiller;
use distillation::DistillationService;
use storage::capture_store::CaptureStore;
use providers::credentials::FileCredentialSource;
use stt::openai::OpenAiTranscriber;

#[cfg(target_os = "android")]
fn platform_recorder(app: &AppHandle) -> Arc<dyn Recorder> {
    app.state::<Arc<audio::android::AndroidRecorder>>().inner().clone()
}

#[cfg(not(target_os = "android"))]
fn platform_recorder(_app: &AppHandle) -> Arc<dyn Recorder> {
    Arc::new(audio::recorder::UnsupportedRecorder)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(audio::android::init());

    builder
        .setup(|app| {
            // App-private data directory: on Android this is the app's internal storage.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(CaptureStore::open(&data_dir.join("arthur.db"))?);

            // The speech-to-text key lives in app-private storage, never in the frontend or the repo.
            let credentials_dir = data_dir.join("credentials");
            std::fs::create_dir_all(&credentials_dir)?;
            let credentials = Arc::new(FileCredentialSource::new(credentials_dir.join("openai_api_key")));
            let transcriber = Arc::new(OpenAiTranscriber::new(credentials.clone())?);
            app.manage(DistillationService::new(Arc::new(OpenAiDistiller::new(credentials)?)));

            // Recordings are transient, so they go in the cache directory.
            let recordings_dir = app.path().app_cache_dir()?.join("recordings");
            app.manage(VoiceCaptureService::new(platform_recorder(app.handle()), transcriber, recordings_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info::get_runtime_info,
            commands::captures::create_capture,
            commands::captures::list_captures,
            commands::voice::start_voice_capture,
            commands::voice::finish_voice_capture,
            commands::voice::cancel_voice_capture,
            commands::distill::distill_capture,
            commands::distill::list_knowledge_objects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Arthur application");
}
