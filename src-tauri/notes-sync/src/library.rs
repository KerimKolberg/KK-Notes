//! The document library: one directory of `.notex` files and folders.
//!
//! Deliberately one level at a time rather than a recursive index. A library
//! is browsed, not searched, and walking the whole tree to show one folder
//! would make opening the app scale with how much the user has ever written.

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

pub const NOTEX_EXTENSION: &str = "notex";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    /// Absolute path on this device.
    pub path: String,
    /// Path relative to the library root, `/`-separated — the name sync uses.
    pub relative_path: String,
    /// File name without the `.notex` extension, or the folder's name.
    pub name: String,
    pub is_folder: bool,
    pub bytes: u64,
    pub modified_ms: u64,
    /// Unix epoch ms. Not every filesystem records a creation time; where it
    /// is missing this falls back to the modification time, so sorting by it
    /// degrades to something sensible instead of piling everything on 1970.
    pub created_ms: u64,
    /// Documents this folder directly contains, for the folder card's subtitle.
    pub child_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListing {
    /// The directory that was listed.
    pub path: String,
    pub relative_path: String,
    /// `None` at the library root.
    pub parent_path: Option<String>,
    pub entries: Vec<LibraryEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    Name,
    Modified,
    Created,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortOrder {
    Ascending,
    Descending,
}

/// `/`-separated path of `path` within `root`, or an empty string for the root.
pub fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rest| rest.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn is_notex(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.eq_ignore_ascii_case(NOTEX_EXTENSION))
        .unwrap_or(false)
}

fn ms(time: Option<std::time::SystemTime>) -> Option<u64> {
    time.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

/// How many `.notex` files a folder holds directly.
fn count_documents(dir: &Path) -> u32 {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    let path = e.path();
                    path.is_dir() || is_notex(&path)
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn entry_for(root: &Path, path: &Path) -> Option<LibraryEntry> {
    let meta = fs::metadata(path).ok()?;
    let is_folder = meta.is_dir();
    if !is_folder && !is_notex(path) {
        return None;
    }
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    // Hidden files, and the sibling temp files an atomic write leaves behind
    // if it is interrupted, are not documents.
    if file_name.starts_with('.') {
        return None;
    }
    let modified_ms = ms(meta.modified().ok()).unwrap_or(0);
    Some(LibraryEntry {
        path: path.to_string_lossy().into_owned(),
        relative_path: relative_to(root, path),
        name: if is_folder {
            file_name
        } else {
            file_name.trim_end_matches(&format!(".{NOTEX_EXTENSION}")).to_string()
        },
        is_folder,
        bytes: if is_folder { 0 } else { meta.len() },
        modified_ms,
        created_ms: ms(meta.created().ok()).unwrap_or(modified_ms),
        child_count: if is_folder { count_documents(path) } else { 0 },
    })
}

/// Sort in place: folders first, then by the chosen key.
///
/// Folders lead whichever direction the sort runs, because they are the
/// structure of the library rather than items in it — a "newest first" sort
/// that scatters folders through the documents makes the place harder to
/// navigate, not easier. Names compare case-insensitively, since a library
/// where `apple` sorts after `Zebra` looks broken.
pub fn sort_entries(entries: &mut [LibraryEntry], key: SortKey, order: SortOrder) {
    entries.sort_by(|a, b| {
        a.is_folder
            .cmp(&b.is_folder)
            .reverse()
            .then_with(|| {
                let ordering = match key {
                    SortKey::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                    SortKey::Modified => a.modified_ms.cmp(&b.modified_ms),
                    SortKey::Created => a.created_ms.cmp(&b.created_ms),
                };
                if order == SortOrder::Descending {
                    ordering.reverse()
                } else {
                    ordering
                }
            })
            // Ties on a timestamp are common (two files saved in the same
            // millisecond, or a filesystem with second resolution), and an
            // unstable order makes the grid reshuffle on every refresh.
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// List one directory of the library.
pub fn list_directory(root: &Path, dir: &Path, key: SortKey, order: SortOrder) -> std::io::Result<LibraryListing> {
    let mut entries: Vec<LibraryEntry> = fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| entry_for(root, &e.path()))
        .collect();
    sort_entries(&mut entries, key, order);
    let parent_path = if dir == root {
        None
    } else {
        dir.parent().map(|p| p.to_string_lossy().into_owned())
    };
    Ok(LibraryListing {
        path: dir.to_string_lossy().into_owned(),
        relative_path: relative_to(root, dir),
        parent_path,
        entries,
    })
}

/**
 * Android's Storage Access Framework hands back `content://` URIs, not paths.
 *
 * Nothing built on `std::fs` can open one: it is treated as a relative path,
 * and the temp-file-plus-rename an atomic write needs cannot exist beside it.
 * Writing one anyway produced files *named* after the URI — which is what
 * made every PDF exported on Android unopenable — so callers check this and
 * route those through the platform's content resolver instead.
 */
pub fn is_content_uri(path: &Path) -> bool {
    let text = path.to_string_lossy();
    // Case-insensitively, and only the scheme: a real file called
    // `content___notes.pdf` is a path like any other.
    text.len() >= 10 && text[..10].eq_ignore_ascii_case("content://")
}

/// Refuse a path that escapes the library root.
///
/// Every path the frontend sends is checked against this. The frontend is not
/// hostile, but it is one `..` in a folder name away from writing outside the
/// library by accident, and a file manager is exactly where that matters.
pub fn within_root(root: &Path, path: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    // The path itself may not exist yet (creating a folder), so resolve the
    // nearest existing ancestor and check that.
    let mut probe = path.to_path_buf();
    loop {
        if let Ok(resolved) = probe.canonicalize() {
            return resolved.starts_with(&root);
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => return false,
        }
    }
}

/// Create a folder inside the library, returning its path.
pub fn create_folder(root: &Path, parent: &Path, name: &str) -> std::io::Result<PathBuf> {
    let clean = sanitise_name(name);
    let path = parent.join(&clean);
    if !within_root(root, &path) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "That folder would sit outside the library",
        ));
    }
    fs::create_dir_all(&path)?;
    Ok(path)
}

/// Move a document or folder into another folder, returning its new path.
///
/// Never overwrites: a name already taken gets a numbered suffix, because
/// dragging a file onto a folder is not a request to destroy whatever was
/// already called that.
pub fn move_entry(root: &Path, from: &Path, into: &Path) -> std::io::Result<PathBuf> {
    if !within_root(root, from) || !within_root(root, into) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "That move would leave the library",
        ));
    }
    if into.starts_with(from) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "A folder cannot be moved inside itself",
        ));
    }
    let name = from
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Nothing to move"))?;
    let destination = unique_path(&into.join(name));
    fs::create_dir_all(into)?;
    fs::rename(from, &destination)?;
    Ok(destination)
}

/// `path`, or `path (2)`, `path (3)`… — whichever is free.
pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (name[..index].to_string(), name[index..].to_string()),
        _ => (name.clone(), String::new()),
    };
    for n in 2..10_000 {
        let candidate = parent.join(format!("{stem} ({n}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem} ({}){extension}", crate::digest::now_ms()))
}

/// Strip what a file name cannot contain, and refuse to be empty or `..`.
pub fn sanitise_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "Untitled folder".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, is_folder: bool, modified: u64, created: u64) -> LibraryEntry {
        LibraryEntry {
            path: format!("/library/{name}"),
            relative_path: name.to_string(),
            name: name.to_string(),
            is_folder,
            bytes: 0,
            modified_ms: modified,
            created_ms: created,
            child_count: 0,
        }
    }

    fn names(entries: &[LibraryEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn folders_lead_whichever_way_the_sort_runs() {
        let mut entries = vec![
            entry("zebra", false, 1, 1),
            entry("Maths", true, 5, 5),
            entry("apple", false, 9, 9),
        ];
        sort_entries(&mut entries, SortKey::Name, SortOrder::Ascending);
        assert_eq!(names(&entries), ["Maths", "apple", "zebra"]);
        sort_entries(&mut entries, SortKey::Name, SortOrder::Descending);
        assert_eq!(names(&entries), ["Maths", "zebra", "apple"]);
        sort_entries(&mut entries, SortKey::Modified, SortOrder::Descending);
        assert_eq!(names(&entries), ["Maths", "apple", "zebra"]);
    }

    #[test]
    fn names_sort_case_insensitively() {
        let mut entries = vec![entry("Zebra", false, 0, 0), entry("apple", false, 0, 0)];
        sort_entries(&mut entries, SortKey::Name, SortOrder::Ascending);
        assert_eq!(names(&entries), ["apple", "Zebra"]);
    }

    #[test]
    fn the_two_date_keys_are_independent() {
        let mut entries = vec![
            entry("edited last", false, 900, 100),
            entry("made last", false, 100, 900),
        ];
        sort_entries(&mut entries, SortKey::Modified, SortOrder::Descending);
        assert_eq!(names(&entries), ["edited last", "made last"]);
        sort_entries(&mut entries, SortKey::Created, SortOrder::Descending);
        assert_eq!(names(&entries), ["made last", "edited last"]);
    }

    #[test]
    fn a_timestamp_tie_falls_back_to_the_name_rather_than_reshuffling() {
        // Two files saved in the same millisecond, or any filesystem with
        // second resolution. Without the tiebreak the grid reorders itself on
        // every refresh.
        let mut entries = vec![
            entry("c", false, 500, 500),
            entry("a", false, 500, 500),
            entry("b", false, 500, 500),
        ];
        sort_entries(&mut entries, SortKey::Modified, SortOrder::Descending);
        assert_eq!(names(&entries), ["a", "b", "c"]);
        let mut again = entries.clone();
        sort_entries(&mut again, SortKey::Modified, SortOrder::Descending);
        assert_eq!(names(&again), names(&entries));
    }

    #[test]
    fn lists_documents_and_folders_and_nothing_else() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        fs::write(path.join("Week 1.notex"), b"{}").unwrap();
        fs::write(path.join("notes.txt"), b"not a document").unwrap();
        fs::write(path.join(".Week 1.notex.123.tmp"), b"interrupted save").unwrap();
        fs::create_dir(path.join("Maths")).unwrap();
        fs::write(path.join("Maths/Algebra.notex"), b"{}").unwrap();

        let listing = list_directory(path, path, SortKey::Name, SortOrder::Ascending).unwrap();
        assert_eq!(names(&listing.entries), ["Maths", "Week 1"]);
        assert!(listing.parent_path.is_none());
        assert_eq!(listing.entries[0].child_count, 1);
        // The extension is dropped from the display name but not the path.
        assert!(listing.entries[1].path.ends_with("Week 1.notex"));
        assert_eq!(listing.entries[1].relative_path, "Week 1.notex");
    }

    #[test]
    fn a_subfolder_knows_its_parent_and_its_relative_path() {
        let root = tempfile::tempdir().unwrap();
        let maths = root.path().join("Maths");
        fs::create_dir(&maths).unwrap();
        fs::write(maths.join("Algebra.notex"), b"{}").unwrap();
        let listing = list_directory(root.path(), &maths, SortKey::Name, SortOrder::Ascending).unwrap();
        assert_eq!(listing.relative_path, "Maths");
        assert_eq!(listing.parent_path.as_deref(), Some(root.path().to_string_lossy().as_ref()));
        assert_eq!(listing.entries[0].relative_path, "Maths/Algebra.notex");
    }

    #[test]
    fn filing_a_document_in_a_folder_moves_it() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("Week 1.notex");
        fs::write(&file, b"{}").unwrap();
        let folder = create_folder(root.path(), root.path(), "Maths").unwrap();
        let moved = move_entry(root.path(), &file, &folder).unwrap();
        assert!(moved.ends_with("Maths/Week 1.notex"));
        assert!(!file.exists());
        assert_eq!(list_directory(root.path(), root.path(), SortKey::Name, SortOrder::Ascending).unwrap().entries.len(), 1);
    }

    #[test]
    fn a_move_never_overwrites_what_is_already_there() {
        let root = tempfile::tempdir().unwrap();
        let folder = create_folder(root.path(), root.path(), "Maths").unwrap();
        fs::write(folder.join("Week 1.notex"), b"the one already filed").unwrap();
        let file = root.path().join("Week 1.notex");
        fs::write(&file, b"the one being filed").unwrap();

        let moved = move_entry(root.path(), &file, &folder).unwrap();
        assert!(moved.ends_with("Week 1 (2).notex"));
        assert_eq!(fs::read(folder.join("Week 1.notex")).unwrap(), b"the one already filed");
        assert_eq!(fs::read(&moved).unwrap(), b"the one being filed");
    }

    #[test]
    fn nothing_may_leave_the_library() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.notex"), b"{}").unwrap();
        assert!(within_root(root.path(), &root.path().join("Maths/new.notex")));
        assert!(!within_root(root.path(), outside.path()));
        assert!(move_entry(root.path(), &root.path().join("a.notex"), outside.path()).is_err());
        assert!(create_folder(root.path(), outside.path(), "Escaped").is_err());
    }

    #[test]
    fn a_folder_cannot_be_moved_into_itself() {
        let root = tempfile::tempdir().unwrap();
        let folder = create_folder(root.path(), root.path(), "Maths").unwrap();
        let inner = create_folder(root.path(), &folder, "Week 1").unwrap();
        assert!(move_entry(root.path(), &folder, &inner).is_err());
    }

    #[test]
    fn a_storage_access_uri_is_not_a_path() {
        assert!(is_content_uri(Path::new("content://com.android.providers.downloads/document/42")));
        assert!(is_content_uri(Path::new("CONTENT://Upper/Case")));
        // Real paths, including ones that merely start with the letters.
        assert!(!is_content_uri(Path::new("/home/me/notes.pdf")));
        assert!(!is_content_uri(Path::new("C:\\Users\\me\\notes.pdf")));
        assert!(!is_content_uri(Path::new("content_notes.pdf")));
        assert!(!is_content_uri(Path::new("content:/")));
        assert!(!is_content_uri(Path::new("")));
    }

    #[test]
    fn a_folder_name_cannot_be_a_path() {
        let root = tempfile::tempdir().unwrap();
        let folder = create_folder(root.path(), root.path(), "Maths/../../escape").unwrap();
        assert!(folder.starts_with(root.path()));
        assert_eq!(sanitise_name("  ..  "), "Untitled folder");
        assert_eq!(sanitise_name("a/b:c"), "a-b-c");
    }
}
