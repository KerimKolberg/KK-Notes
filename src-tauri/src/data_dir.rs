//! The app's own folders, named like the app.
//!
//! Tauri names an app's folders after its bundle identifier (`com.notex.app`), which is what anyone looking in
//! `%APPDATA%` or `%LOCALAPPDATA%` on Windows used to find. They are named KK-Notes now:
//!
//! - **`%APPDATA%\KK-Notes`** holds the library, the drafts, the version history and the settings. The old
//!   folder is moved on the first start (`notes_sync::relocate`, which also keeps the recent documents and each
//!   note's version history pointing at the right place); the page moves its favourites and tags itself, told
//!   where the library was by [`library_moved`].
//! - **`%LOCALAPPDATA%\KK-Notes`** holds the web view's own data — the page's storage, its preferences among it
//!   (`EBWebView`). It is the installer's folder too; the uninstaller leaves it unless asked to delete the app's
//!   data (`windows/hooks.nsh`).
//!
//! Elsewhere nothing changes. On Android the identifier *is* the app (its package name, which its Google
//! sign-in is registered to), and its folders are private to it anyway.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const LIBRARY_DIR: &str = "library";
pub const HISTORY_DIR: &str = "history";
pub const RECENT_FILE: &str = "recent.json";

/// Where the app's folders are, once [`setup`] has decided.
pub struct DataDir {
    /// The library, drafts, history and settings.
    pub path: PathBuf,
    /// The web view's data, where it is not Tauri's choice.
    pub webview: Option<PathBuf>,
    /// The folder the data was in before it was named like the app, if it was moved from there.
    legacy: Option<PathBuf>,
}

/// The app's data folder.
pub fn get(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = app.try_state::<DataDir>() {
        return Ok(dir.path.clone());
    }
    app.path().app_data_dir().map_err(|e| format!("No application data directory: {e}"))
}

/// The library's old and new folders, when the data folder was renamed; the page re-keys what it keeps by path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMove {
    pub from: String,
    pub to: String,
}

#[tauri::command]
pub fn library_moved(app: AppHandle) -> Option<LibraryMove> {
    let dir = app.try_state::<DataDir>()?;
    let legacy = dir.legacy.as_ref()?;
    Some(LibraryMove {
        from: legacy.join(LIBRARY_DIR).to_string_lossy().into_owned(),
        to: dir.path.join(LIBRARY_DIR).to_string_lossy().into_owned(),
    })
}

/// Decide the folders, moving the old ones if this is the first start since they were renamed. Before anything
/// reads or writes in them, and before the window (and its web view) exists.
pub fn setup(app: &AppHandle) {
    let fallback = app.path().app_data_dir().unwrap_or_default();
    let dir = named(app).unwrap_or(DataDir { path: fallback, webview: None, legacy: None });
    app.manage(dir);
}

#[cfg(windows)]
fn named(app: &AppHandle) -> Option<DataDir> {
    use notes_sync::relocate::{settle, Layout};
    let name = app.config().product_name.clone()?;
    let path = app.path();
    let (legacy, named) = (path.app_data_dir().ok()?, path.data_dir().ok()?.join(&name));
    let layout = Layout { library: LIBRARY_DIR, history: HISTORY_DIR, recent: RECENT_FILE };
    let data = settle(&legacy, &named, layout);
    let moved_from = (data.folder == named).then_some(legacy);

    // The web view's data: the folder Tauri would have used holds it as `EBWebView`.
    let (old_local, new_local) = (path.app_local_data_dir().ok()?, path.local_data_dir().ok()?.join(&name));
    let webview = move_webview_data(&old_local, &new_local);
    Some(DataDir { path: data.folder, webview: Some(webview), legacy: moved_from })
}

#[cfg(not(windows))]
fn named(_app: &AppHandle) -> Option<DataDir> {
    None
}

/// Move the web view's data into `to`, and say where it is: `from` again if it could not be moved (an older copy
/// of the app still running holds it), so nothing is lost and the move is tried on the next start.
#[cfg_attr(not(windows), allow(dead_code))]
fn move_webview_data(from: &Path, to: &Path) -> PathBuf {
    const WEBVIEW: &str = "EBWebView";
    let (old, new) = (from.join(WEBVIEW), to.join(WEBVIEW));
    if new.exists() || !old.exists() {
        return to.to_path_buf();
    }
    if std::fs::create_dir_all(to).is_err() || std::fs::rename(&old, &new).is_err() {
        return from.to_path_buf();
    }
    // The old folder held nothing else of ours; take it away if that is so.
    let _ = std::fs::remove_dir(from);
    to.to_path_buf()
}

/// Build the main window, on the platforms where it is not made from the configuration (`create: false` in
/// `tauri.windows.conf.json`): its web view keeps its data in the folder [`setup`] chose.
#[cfg(windows)]
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main" && !w.create).cloned() else {
        return Ok(());
    };
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    if let Some(webview) = app.try_state::<DataDir>().and_then(|d| d.webview.clone()) {
        builder = builder.data_directory(webview);
    }
    builder.build()?;
    Ok(())
}
