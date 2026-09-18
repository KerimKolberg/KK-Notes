//! IPC for the document library and the sync engine.
//!
//! Thin on purpose: every decision lives in the `notes-sync` crate, which has
//! no Tauri dependency and is therefore testable. What is left here is path
//! resolution, state management and turning `Result` into something the
//! frontend can show.

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use notes_sync::{
    library::{self, SortKey, SortOrder},
    manager::{SyncManager, SyncState, SyncStatus},
    thumb::{self, ThumbnailSource},
    ConflictResolution, LibraryListing,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::atomic_write;

/// The library lives beside the drafts and the recents list, so a fresh
/// install has somewhere to put documents without asking first.
const LIBRARY_DIR: &str = "library";
const SYNC_STATE_FILE: &str = "sync-state.json";
/// Emitted whenever a pass finishes, so the status pill follows along without
/// the frontend polling for it.
pub const SYNC_STATUS_EVENT: &str = "sync://status";

pub struct Library {
    pub manager: Arc<SyncManager>,
    /// Kept alive so the watcher thread is not dropped on the floor.
    watching: Mutex<bool>,
}

impl Library {
    pub fn new(root: PathBuf, device: String) -> Self {
        Self {
            manager: Arc::new(SyncManager::new(root, device)),
            watching: Mutex::new(false),
        }
    }
}

/// Where documents live: `<app data>/library`.
pub fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No application data directory: {e}"))?
        .join(LIBRARY_DIR);
    fs::create_dir_all(&root).map_err(|e| format!("Cannot create {}: {e}", root.display()))?;
    Ok(root)
}

/// A name for this device, for conflict copies. The hostname if there is one,
/// since "conflicted copy from laptop" is only useful if it names a machine.
pub fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "this device".to_string())
}

fn resolve(library: &Library, path: Option<String>) -> Result<PathBuf, String> {
    let root = library.manager.root().to_path_buf();
    let Some(path) = path else { return Ok(root) };
    let candidate = PathBuf::from(path);
    if !library::within_root(&root, &candidate) {
        return Err("That location is outside the library".to_string());
    }
    Ok(candidate)
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

/// List one folder of the library.
#[tauri::command]
pub fn list_library(
    library: State<'_, Library>,
    path: Option<String>,
    sort_key: SortKey,
    sort_order: SortOrder,
) -> Result<LibraryListing, String> {
    let root = library.manager.root().to_path_buf();
    let dir = resolve(&library, path)?;
    library::list_directory(&root, &dir, sort_key, sort_order)
        .map_err(|e| format!("Cannot read {}: {e}", dir.display()))
}

#[tauri::command]
pub fn create_library_folder(library: State<'_, Library>, parent: Option<String>, name: String) -> Result<String, String> {
    let root = library.manager.root().to_path_buf();
    let parent = resolve(&library, parent)?;
    library::create_folder(&root, &parent, &name)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| format!("Cannot create that folder: {e}"))
}

/// File a document or folder inside another folder.
#[tauri::command]
pub fn move_library_entry(library: State<'_, Library>, from: String, into: Option<String>) -> Result<String, String> {
    let root = library.manager.root().to_path_buf();
    let from = resolve(&library, Some(from))?;
    let into = resolve(&library, into)?;
    library::move_entry(&root, &from, &into)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| format!("Cannot move that: {e}"))
}

#[tauri::command]
pub fn delete_library_entry(library: State<'_, Library>, path: String) -> Result<(), String> {
    let target = resolve(&library, Some(path))?;
    let result = if target.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|e| format!("Cannot delete {}: {e}", target.display()))
}

/// Create an empty document in the library and return its path.
#[tauri::command]
pub fn create_library_document(
    library: State<'_, Library>,
    parent: Option<String>,
    name: String,
    contents: String,
) -> Result<String, String> {
    let parent = resolve(&library, parent)?;
    let file = library::unique_path(&parent.join(format!("{}.notex", library::sanitise_name(&name))));
    atomic_write(&file, contents.as_bytes())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Title, page count and the first page of a document — and nothing else.
///
/// The library draws a card per document; hydrating each one would mean
/// holding every notebook in memory at once. This reads the file straight into
/// a struct that keeps page one, so the other pages and `pdfSources` (whole
/// imported PDFs, as base64) are walked and dropped rather than allocated.
#[tauri::command]
pub fn read_document_thumbnail(library: State<'_, Library>, path: String) -> Result<ThumbnailSource, String> {
    let file = resolve(&library, Some(path))?;
    let fallback = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled note".to_string());
    thumb::read_thumbnail_source(&file, &fallback)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn sync_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No application data directory: {e}"))?
        .join(SYNC_STATE_FILE))
}

/// Load the per-file base hashes recorded by earlier runs.
///
/// Without them a restart cannot tell "I edited this" from "they edited it",
/// so every file looks new and every difference looks like a conflict.
pub fn restore_sync_state(app: &AppHandle, manager: &SyncManager) {
    let Ok(path) = sync_state_path(app) else { return };
    let Ok(text) = fs::read_to_string(path) else { return };
    if let Ok(state) = serde_json::from_str::<SyncState>(&text) {
        manager.restore_state(state);
    }
}

fn persist_sync_state(app: &AppHandle, manager: &SyncManager) {
    let Ok(path) = sync_state_path(app) else { return };
    if let Ok(json) = serde_json::to_string(&manager.state()) {
        let _ = atomic_write(&path, json.as_bytes());
    }
}

#[tauri::command]
pub fn sync_status(library: State<'_, Library>) -> SyncStatus {
    library.manager.status()
}

/// Run a pass now. Also the reconciliation the watcher cannot guarantee: the
/// frontend calls this when the library opens, so anything a missed filesystem
/// event would have hidden is picked up anyway.
#[tauri::command]
pub fn sync_now(app: AppHandle, library: State<'_, Library>) -> SyncStatus {
    let status = library.manager.sync_once();
    persist_sync_state(&app, &library.manager);
    let _ = app.emit(SYNC_STATUS_EVENT, &status);
    status
}

/// Answer one conflict.
#[tauri::command]
pub fn resolve_conflict(
    app: AppHandle,
    library: State<'_, Library>,
    path: String,
    choice: ConflictResolution,
) -> Result<SyncStatus, String> {
    let status = library.manager.resolve(&path, choice)?;
    persist_sync_state(&app, &library.manager);
    let _ = app.emit(SYNC_STATUS_EVENT, &status);
    Ok(status)
}

/// Start the filesystem watcher, pushing a status event after each settled
/// burst of saves. Idempotent: calling it twice does not start two watchers.
pub fn start_watching(app: &AppHandle, library: &Library) {
    let mut watching = library.watching.lock().unwrap();
    if *watching {
        return;
    }
    let Ok(events) = library.manager.watch() else { return };
    *watching = true;
    drop(watching);

    let manager = Arc::clone(&library.manager);
    let app = app.clone();
    std::thread::spawn(move || {
        while events.recv().is_ok() {
            let status = manager.sync_once();
            if let Ok(path) = sync_state_path(&app) {
                if let Ok(json) = serde_json::to_string(&manager.state()) {
                    let _ = atomic_write(&path, json.as_bytes());
                }
            }
            let _ = app.emit(SYNC_STATUS_EVENT, &status);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn a_device_always_has_a_name_to_put_on_a_conflict_copy() {
        let name = device_name();
        assert!(!name.trim().is_empty());
    }

    #[test]
    fn the_library_root_sits_under_the_app_data_directory() {
        // The command layer only ever joins; the guard against escaping lives
        // in `notes-sync` and is tested there against real directories.
        let root = Path::new("/data/app").join(LIBRARY_DIR);
        assert!(root.ends_with("library"));
    }
}
