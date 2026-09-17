//! Tauri shell for the multi-page inking app.
//!
//! The frontend owns all document logic; this crate provides native file
//! persistence (atomic `.notex` writes, raw binary PDF writes, autosave
//! drafts and a recent-files list in the app data directory) and exposes the
//! file the app was launched with (`.notex` file association).

mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::StartupFile::from_args())
        .invoke_handler(tauri::generate_handler![
            commands::save_document,
            commands::open_document,
            commands::write_binary_file,
            commands::save_draft,
            commands::load_draft,
            commands::clear_draft,
            commands::list_recent,
            commands::add_recent,
            commands::remove_recent,
            commands::get_startup_file,
        ])
        .setup(|app| {
            // Make sure the per-user data directory exists before the first autosave.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Notes application");
}
