//! Tauri shell for the multi-page inking app.
//!
//! The frontend owns all document logic; this crate provides native file
//! persistence (atomic `.notex` writes, raw binary PDF writes, autosave
//! drafts and a recent-files list in the app data directory), the document
//! library on disk, and exposes the file the app was launched with (`.notex`
//! file association).
//!
//! The library and sync engine themselves live in the `notes-sync` crate,
//! which carries no Tauri dependency so it can be compiled and tested without
//! a platform webview. What is here is the IPC surface over it.

mod commands;
mod library_commands;

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
            library_commands::list_library,
            library_commands::create_library_folder,
            library_commands::create_library_document,
            library_commands::move_library_entry,
            library_commands::delete_library_entry,
            library_commands::read_document_thumbnail,
            library_commands::sync_status,
            library_commands::sync_now,
            library_commands::resolve_conflict,
        ])
        .setup(|app| {
            // Make sure the per-user data directory exists before the first autosave.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // The library, its persisted sync records and the watcher over it.
            let handle = app.handle().clone();
            let root = library_commands::library_root(&handle).map_err(std::io::Error::other)?;
            let library = library_commands::Library::new(root, library_commands::device_name());
            library_commands::restore_sync_state(&handle, &library.manager);
            library_commands::start_watching(&handle, &library);
            app.manage(library);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Notes application");
}
