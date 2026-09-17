//! IPC commands. All writes are atomic (temp file + rename) so a crash or
//! power loss mid-save never leaves a truncated document behind.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State,
};

pub const NOTEX_EXTENSION: &str = "notex";
const MAX_RECENT: usize = 5;
const DRAFT_DIR: &str = "drafts";
const DRAFT_FILE: &str = "autosave.notex";
const RECENT_FILE: &str = "recent.json";
/// Refuse to read documents larger than this (bytes) to keep the UI responsive.
const MAX_DOCUMENT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub bytes: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub path: String,
    pub contents: String,
    pub info: FileInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub title: String,
    pub opened_ms: u64,
}

/// The `.notex` path passed on the command line (file association / "Open with").
pub struct StartupFile(pub Mutex<Option<String>>);

impl StartupFile {
    pub fn from_args() -> Self {
        let file = std::env::args().skip(1).find(|arg| {
            !arg.starts_with('-')
                && Path::new(arg)
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case(NOTEX_EXTENSION))
                    .unwrap_or(false)
        });
        Self(Mutex::new(file))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn describe(path: &Path) -> Result<FileInfo, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot stat {}: {e}", path.display()))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileInfo {
        path: path.to_string_lossy().into_owned(),
        bytes: meta.len(),
        modified_ms,
    })
}

/// Write `bytes` to `path` via a sibling temp file and an atomic rename.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<FileInfo, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
        }
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string());
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("Cannot create {}: {e}", tmp.display()))?;
        file.write_all(bytes).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
        file.sync_all().map_err(|e| format!("Cannot flush {}: {e}", tmp.display()))?;
    }
    // `rename` replaces an existing destination on both Windows and POSIX.
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot replace {}: {e}", path.display()));
    }
    describe(path)
}

fn read_document_file(path: &Path) -> Result<OpenedDocument, String> {
    let info = describe(path)?;
    if info.bytes > MAX_DOCUMENT_BYTES {
        return Err(format!("{} is too large to open ({} bytes)", path.display(), info.bytes));
    }
    let contents = fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    Ok(OpenedDocument {
        path: path.to_string_lossy().into_owned(),
        contents,
        info,
    })
}

fn app_data_path(app: &AppHandle, parts: &[&str]) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No application data directory: {e}"))?;
    for part in parts {
        path.push(part);
    }
    Ok(path)
}

/// Decode a percent-encoded header value (paths may contain non-ASCII).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 0 && i + 2 <= bytes.len() - 1 {
            if let Ok(value) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// Save a `.notex` document (UTF-8 JSON) atomically.
#[tauri::command]
pub fn save_document(path: String, contents: String) -> Result<FileInfo, String> {
    atomic_write(Path::new(&path), contents.as_bytes())
}

/// Read a `.notex` document.
#[tauri::command]
pub fn open_document(path: String) -> Result<OpenedDocument, String> {
    read_document_file(Path::new(&path))
}

/// Write raw bytes (e.g. an exported PDF) sent as the IPC body, with the
/// destination in the percent-encoded `x-path` header. Avoids JSON-encoding
/// megabytes of binary as number arrays.
#[tauri::command]
pub fn write_binary_file(request: Request<'_>) -> Result<FileInfo, String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| "Missing x-path header".to_string())?;
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("Expected a binary body".to_string()),
    };
    atomic_write(Path::new(&path), bytes)
}

// ---------------------------------------------------------------------------
// Autosave drafts
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_draft(app: AppHandle, contents: String) -> Result<FileInfo, String> {
    let path = app_data_path(&app, &[DRAFT_DIR, DRAFT_FILE])?;
    atomic_write(&path, contents.as_bytes())
}

#[tauri::command]
pub fn load_draft(app: AppHandle) -> Result<Option<OpenedDocument>, String> {
    let path = app_data_path(&app, &[DRAFT_DIR, DRAFT_FILE])?;
    if !path.exists() {
        return Ok(None);
    }
    read_document_file(&path).map(Some)
}

#[tauri::command]
pub fn clear_draft(app: AppHandle) -> Result<(), String> {
    let path = app_data_path(&app, &[DRAFT_DIR, DRAFT_FILE])?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove {}: {e}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

fn read_recent(app: &AppHandle) -> Result<Vec<RecentFile>, String> {
    let path = app_data_path(app, &[RECENT_FILE])?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut list: Vec<RecentFile> = serde_json::from_str(&text).unwrap_or_default();
    // Drop entries whose files have disappeared.
    list.retain(|entry| Path::new(&entry.path).exists());
    list.truncate(MAX_RECENT);
    Ok(list)
}

fn write_recent(app: &AppHandle, list: &[RecentFile]) -> Result<(), String> {
    let path = app_data_path(app, &[RECENT_FILE])?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    atomic_write(&path, json.as_bytes()).map(|_| ())
}

/// Pure recents update: most recent first, de-duplicated by path, capped.
pub fn push_recent(mut list: Vec<RecentFile>, entry: RecentFile) -> Vec<RecentFile> {
    list.retain(|e| e.path != entry.path);
    list.insert(0, entry);
    list.truncate(MAX_RECENT);
    list
}

#[tauri::command]
pub fn list_recent(app: AppHandle) -> Result<Vec<RecentFile>, String> {
    read_recent(&app)
}

#[tauri::command]
pub fn add_recent(app: AppHandle, path: String, title: String) -> Result<Vec<RecentFile>, String> {
    let list = push_recent(
        read_recent(&app)?,
        RecentFile {
            path,
            title,
            opened_ms: now_ms(),
        },
    );
    write_recent(&app, &list)?;
    Ok(list)
}

#[tauri::command]
pub fn remove_recent(app: AppHandle, path: String) -> Result<Vec<RecentFile>, String> {
    let mut list = read_recent(&app)?;
    list.retain(|e| e.path != path);
    write_recent(&app, &list)?;
    Ok(list)
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// The `.notex` file the process was launched with, handed out once.
#[tauri::command]
pub fn get_startup_file(state: State<'_, StartupFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recents_dedupe_and_cap() {
        let mut list = Vec::new();
        for i in 0..7 {
            list = push_recent(
                list,
                RecentFile {
                    path: format!("/docs/{i}.notex"),
                    title: format!("Doc {i}"),
                    opened_ms: i,
                },
            );
        }
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0].path, "/docs/6.notex");
        let list = push_recent(
            list,
            RecentFile {
                path: "/docs/3.notex".into(),
                title: "Doc 3 again".into(),
                opened_ms: 99,
            },
        );
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0].path, "/docs/3.notex");
        assert_eq!(list.iter().filter(|e| e.path == "/docs/3.notex").count(), 1);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cme%2Fnotes.pdf"), "C:\\Users\\me/notes.pdf");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("%E2%9C%93"), "✓");
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = std::env::temp_dir().join(format!("notex-test-{}", std::process::id()));
        let path = dir.join("doc.notex");
        atomic_write(&path, b"one").unwrap();
        let info = atomic_write(&path, b"two").unwrap();
        assert_eq!(info.bytes, 3);
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert!(fs::read_dir(&dir).unwrap().count() == 1, "temp file must not linger");
        let _ = fs::remove_dir_all(&dir);
    }
}
