mod async_util;
mod audio;
mod commands;
mod distillation;
mod evolution_runtime;
mod graph;
#[allow(dead_code)]
// M04.7B: the pure identity core is used through the evolution pipeline; parts are exercised by tests alone
mod identity;
#[allow(dead_code)]
// M04.7B: only `evolution_runtime` builds the TypeSafe JEV adapter; parts of it are exercised by tests alone
mod jev;
mod lifecycle;
mod lineage;
#[cfg(test)]
mod live_luna_smoke;
mod native_security;
mod platform;
mod providers;
mod recall;
mod runtime;
mod storage;
mod stt;
#[allow(dead_code)] // M05 dormant sync candidate; no production composition/ingress.
mod sync;
mod sync_api;
#[allow(dead_code)]
// M04.7B: only `evolution_runtime` builds synthesis and verification (review-first); parts are exercised by tests alone
mod synthesis;
#[cfg(test)]
mod test_support;
mod tts;

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use audio::recorder::Recorder;
use audio::voice_capture::VoiceCaptureService;
use distillation::openai::OpenAiDistiller;
use distillation::DistillationService;
use graph::integration::{IntegrationService, IntegrationSettings, Ledger};
use graph::openai::{OpenAiRelationProposer, OpenAiRelationVerifier};
use graph::GraphService;
use providers::ai::AiService;
use providers::ai_config::AiConfigStore;
use providers::embed::OpenAiEmbedder;
use providers::registry::Capability;
use providers::secrets::{select_store, SecretStore, StoragePlatform};
use recall::settings::SemanticSettings;
use recall::RecallService;
use runtime::NativeRuntime;
use stt::openai::OpenAiTranscriber;
use tts::openai::OpenAiSynthesizer;
use tts::player::AudioPlayer;
use tts::service::SpeechService;

#[cfg(target_os = "android")]
fn platform_recorder(app: &AppHandle) -> Arc<dyn Recorder> {
    app.state::<Arc<audio::android::AndroidRecorder>>()
        .inner()
        .clone()
}

#[cfg(not(target_os = "android"))]
fn platform_recorder(_app: &AppHandle) -> Arc<dyn Recorder> {
    Arc::new(audio::recorder::UnsupportedRecorder)
}

/// The Android Keystore bridge, when this build has one and it registered.
#[cfg(target_os = "android")]
fn keystore(app: &AppHandle) -> Option<Arc<dyn SecretStore>> {
    app.try_state::<Arc<providers::android_keystore::AndroidKeystoreStore>>()
        .map(|state| state.inner().clone() as Arc<dyn SecretStore>)
}

#[cfg(not(target_os = "android"))]
fn keystore(_app: &AppHandle) -> Option<Arc<dyn SecretStore>> {
    None
}

/// The platform's audio output. Desktop development builds have none, so voice output reports itself unavailable there.
#[cfg(target_os = "android")]
fn audio_player(app: &AppHandle) -> Arc<dyn AudioPlayer> {
    app.state::<Arc<tts::android::AndroidPlayer>>()
        .inner()
        .clone()
}

#[cfg(not(target_os = "android"))]
fn audio_player(_app: &AppHandle) -> Arc<dyn AudioPlayer> {
    Arc::new(tts::player::UnavailablePlayer)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(audio::android::init())
        .plugin(providers::android_keystore::init())
        .plugin(tts::android::init());

    builder
        .setup(|app| {
            // App-private data directory: on Android this is the app's internal storage.
            let data_dir = app.path().app_data_dir()?;
            let runtime = NativeRuntime::acquire(&data_dir)?;
            let data_dir = runtime.data_root().to_path_buf();
            app.manage(runtime);

            // Provider credentials live in secure storage (Android Keystore on Android) and are resolved per capability on every
            // request; they never reach the frontend, the database or the settings files.
            let credentials_dir = data_dir.join("credentials");
            std::fs::create_dir_all(&credentials_dir)?;
            let platform = StoragePlatform::current();
            let secrets = select_store(platform, keystore(app.handle()), credentials_dir.clone());
            let evolution_secrets = secrets.clone();
            // Only Android has a legacy plaintext file to move into the Keystore; on desktop the store reads that same file.
            let legacy_file = (platform == StoragePlatform::Android)
                .then(|| credentials_dir.join("openai_api_key"));
            let ai = Arc::new(AiService::new(
                AiConfigStore::new(data_dir.join("ai").join("config.json")),
                secrets,
                legacy_file.as_deref(),
            ));
            app.manage(ai.clone());
            let llm = ai.credential_for(Capability::Llm);
            let stt = ai.credential_for(Capability::Stt);
            let embeddings = ai.credential_for(Capability::Embeddings);
            let tts_credential = ai.credential_for(Capability::Tts);
            let transcriber = Arc::new(OpenAiTranscriber::new(stt)?);
            // Automatic Thought Evolution (M04.7B Phase 5): REVIEW-FIRST. The pipeline is installed but stays OFF until a person turns it on,
            // and even then it only stores suggestions; applying one takes their explicit approval. With it OFF, distillation is unchanged.
            let evolution = evolution_runtime::build(
                &data_dir.join("evolution"),
                evolution_secrets,
                llm.clone(),
            )?;
            app.manage(evolution.runtime);
            app.manage(
                DistillationService::new(Arc::new(OpenAiDistiller::new(llm.clone())?))
                    .with_evolution(evolution.pipeline),
            );
            let proposer = Arc::new(OpenAiRelationProposer::new(llm.clone())?);
            let verifier = Arc::new(OpenAiRelationVerifier::new(llm.clone())?);
            app.manage(GraphService::new(proposer.clone(), verifier.clone()));

            // Automatic Graph Integration (M04.7A): new and meaningfully changed knowledge is integrated into the graph in the
            // background. OFF until the user turns it on; the switch and the retry ledger are app-private files, not the database.
            let graph_dir = data_dir.join("graph");
            app.manage(IntegrationService::new(
                GraphService::new(proposer, verifier),
                IntegrationSettings::new(graph_dir.join("integration-settings.json")),
                Ledger::new(graph_dir.join("integration-ledger.json")),
            ));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(commands::integration::RETRY_POLL).await;
                    commands::integration::kick_retries(&handle);
                }
            });
            // Diagnostics only: the retry poll is the one long-lived task of Graph Integration (each event spawns its own short task).
            app.state::<IntegrationService>()
                .diagnostics
                .mark_worker_started();

            // Semantic Recall is OPT-IN. The consent lives in app-private settings, outside the database, and a missing or damaged
            // file means OFF. Having an API key never enables it.
            let settings = Arc::new(SemanticSettings::new(
                data_dir.join("recall").join("semantic.json"),
            ));
            app.manage(
                RecallService::new(Arc::new(OpenAiEmbedder::new(embeddings)?), settings)
                    .with_answer_model(Arc::new(providers::answer::OpenAiAnswerModel::new(llm)?)),
            );
            commands::recall::kick_indexer(app.handle());
            // The indexer finds its own work (new objects, edits, merges that became current) on a slow poll; it is a no-op while
            // semantic Recall is off. Distillation and Lineage are not touched by Recall.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(commands::recall::INDEX_POLL).await;
                    commands::recall::kick_indexer(&handle);
                }
            });

            // Spoken audio is transient too: written to the cache only while it plays and deleted straight after. Whatever a crashed run
            // left there is removed now. Nothing about what was spoken is stored.
            let speech_dir = app.path().app_cache_dir()?.join("tts");
            app.manage(SpeechService::new(
                Arc::new(OpenAiSynthesizer::new(tts_credential)?),
                audio_player(app.handle()),
                speech_dir,
            ));

            // Recordings are transient, so they go in the cache directory.
            let recordings_dir = app.path().app_cache_dir()?.join("recordings");
            app.manage(VoiceCaptureService::new(
                platform_recorder(app.handle()),
                transcriber,
                recordings_dir,
            )?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info::get_runtime_info,
            commands::ai::get_ai_config,
            commands::ai::set_provider_credential,
            commands::ai::has_provider_credential,
            commands::ai::delete_provider_credential,
            commands::ai::test_provider,
            commands::ai::complete_setup,
            commands::speech::speak_text,
            commands::speech::test_voice,
            commands::speech::stop_speech,
            commands::speech::get_speech_status,
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
            commands::evolution::get_evolution_status,
            commands::evolution::set_evolution_enabled,
            commands::evolution::set_evolution_consent,
            commands::evolution::set_typesafe_credential,
            commands::evolution::delete_typesafe_credential,
            commands::evolution::list_revision_proposals,
            commands::evolution::get_revision_proposal,
            commands::evolution::list_unresolved_claims,
            commands::evolution::review_revision_proposal,
            commands::evolution::resolve_unresolved_claim,
            commands::evolution::list_object_approvals,
            commands::evolution::restore_revision,
            commands::distill::list_knowledge_objects,
            commands::distill::list_organization_states,
            commands::distill::get_knowledge_summaries,
            commands::graph::create_relation,
            commands::graph::list_relations,
            commands::graph::get_object_relations,
            commands::graph::get_object_neighbors,
            commands::graph::infer_relations,
            commands::integration::get_graph_integration,
            commands::integration::set_graph_integration_enabled,
            commands::integration::get_graph_integration_diagnostics,
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
            commands::recall::recall_retrieve,
            commands::recall::ask,
            commands::recall::get_semantic_recall_status,
            commands::recall::set_semantic_recall_enabled,
            commands::recall::purge_semantic_index,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Arthur application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                lifecycle::leave_process();
            }
        });
}
