mod commands;
mod platform;
mod storage;

use tauri::Manager;

use storage::capture_store::CaptureStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // App-private data directory: on Android this is the app's internal files dir.
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            app.manage(CaptureStore::open(&directory.join("arthur.db"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info::get_runtime_info,
            commands::captures::create_capture,
            commands::captures::list_captures,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Arthur application");
}
