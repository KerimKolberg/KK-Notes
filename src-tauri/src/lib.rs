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
//! a platform webview — as does Google Drive sync and the whole OAuth
//! exchange behind it. What is here is the IPC surface over them, plus the
//! two things that genuinely need the platform: opening the system browser
//! for consent, and keeping the refresh token.

mod background;
mod commands;
mod data_dir;
mod drive_commands;
mod handwriting;
mod library_commands;
mod transport;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // The desktop's background life (`background.rs`). The single-instance plugin goes first, so a second
    // launch is turned back before anything else of it starts.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(background::second_instance))
        .plugin(tauri_plugin_autostart::Builder::new().args([background::AUTOSTART_ARG]).build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                background::on_close_requested(window, api);
            }
        });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(commands::StartupFile::from_args())
        .invoke_handler(tauri::generate_handler![
            commands::save_document,
            commands::list_versions,
            commands::restore_version,
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
            library_commands::read_document_text,
            handwriting::ink_recognizers,
            handwriting::recognize_ink,
            library_commands::sync_status,
            library_commands::sync_now,
            library_commands::resolve_conflict,
            drive_commands::drive_account,
            drive_commands::drive_sign_in,
            drive_commands::drive_complete_sign_in,
            drive_commands::drive_sign_out,
            background::background_settings,
            background::set_background_settings,
            background::quit_app,
            data_dir::library_moved,
        ])
        .setup(|app| {
            // Before anything reads or writes the app's folders, or the window's web view opens its own.
            data_dir::setup(app.handle());
            #[cfg(windows)]
            data_dir::create_main_window(app.handle())?;
            // Then whether the window shows at all, before anything slower can keep it from showing.
            background::setup(app.handle());

            // Make sure the per-user data directory exists before the first autosave.
            let data_dir = data_dir::get(app.handle()).map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&data_dir)?;

            // The library, its persisted sync records and the watcher over it.
            let handle = app.handle().clone();
            let root = library_commands::library_root(&handle).map_err(std::io::Error::other)?;
            let library = library_commands::Library::new(root, library_commands::device_name());
            library_commands::restore_sync_state(&handle, &library.manager);
            library_commands::start_watching(&handle, &library);
            app.manage(library);

            // The Google account, restored from the store. A device that was
            // connected yesterday is connected again on launch, without anyone
            // having to press anything.
            app.manage(drive_commands::Drive::new(&handle));
            drive_commands::attach_provider(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Notes application");
}
