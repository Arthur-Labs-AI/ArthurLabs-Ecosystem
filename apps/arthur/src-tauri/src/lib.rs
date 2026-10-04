mod commands;
mod platform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::runtime_info::get_runtime_info])
        .run(tauri::generate_context!())
        .expect("error while running the Arthur application");
}
