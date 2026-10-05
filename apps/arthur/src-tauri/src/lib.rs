mod async_util;
mod audio;
mod commands;
mod distillation;
mod graph;
mod lifecycle;
mod lineage;
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
use graph::openai::{OpenAiRelationProposer, OpenAiRelationVerifier};
use graph::GraphService;
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
            app.manage(DistillationService::new(Arc::new(OpenAiDistiller::new(credentials.clone())?)));
            app.manage(GraphService::new(Arc::new(OpenAiRelationProposer::new(credentials.clone())?), Arc::new(OpenAiRelationVerifier::new(credentials)?)));

            // Recordings are transient, so they go in the cache directory.
            let recordings_dir = app.path().app_cache_dir()?.join("recordings");
            app.manage(VoiceCaptureService::new(platform_recorder(app.handle()), transcriber, recordings_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info::get_runtime_info,
            commands::captures::create_capture,
            commands::captures::list_captures,
            commands::captures::get_captures,
            commands::voice::start_voice_capture,
            commands::voice::finish_voice_capture,
            commands::voice::cancel_voice_capture,
            commands::voice::retry_voice_transcription,
            commands::voice::discard_voice_recording,
            commands::voice::get_microphone_permission,
            commands::voice::open_app_settings,
            commands::distill::distill_capture,
            commands::distill::list_knowledge_objects,
            commands::distill::list_organization_states,
            commands::distill::get_knowledge_summaries,
            commands::graph::create_relation,
            commands::graph::list_relations,
            commands::graph::get_object_relations,
            commands::graph::get_object_neighbors,
            commands::graph::infer_relations,
            commands::lineage::get_object_lineage,
            commands::lineage::list_revisions,
            commands::lineage::get_revision,
            commands::lineage::get_revision_parents,
            commands::lineage::get_revision_children,
            commands::lineage::update_knowledge_object,
            commands::lineage::create_revision_from,
            commands::lineage::merge_revisions,
            commands::lineage::diff_revisions,
            commands::projects::list_projects,
            commands::projects::get_project,
            commands::projects::create_project,
            commands::projects::rename_project,
            commands::projects::archive_project,
            commands::projects::restore_project,
            commands::projects::move_capture,
            commands::projects::move_knowledge_object,
            commands::projects::get_active_project,
            commands::projects::set_active_project,
            commands::projects::get_project_graph,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Arthur application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                lifecycle::leave_process();
            }
        });
}

