//! Moving the app's data folder to a new name, and everything that remembered where things were in it.
//!
//! Earlier versions kept the library, the drafts, the version history and the settings in a folder named after
//! the bundle identifier (`com.notex.app`); the app is called KK-Notes, and so is its folder now. Moving the
//! folder is one rename, but three things recorded *absolute* paths into it and would quietly lose track:
//!
//! - the recent-documents list (`recent.json`), whose entries for notes in the library would point nowhere and
//!   be pruned;
//! - the version history, whose folders are named by a hash of the document's path ([`history::folder_for`]),
//!   so every note in the library would seem to have none;
//! - the page's favourites and tags, keyed by path in its own storage — which this crate cannot reach, so the
//!   page is told the old and new library folders and moves its keys itself.
//!
//! Nothing here is specific to Windows, where it is used; the shell decides the two folders.
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::history;

/// The folder to use, and whether it was moved there just now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    pub folder: PathBuf,
    pub moved: bool,
}

/// What the move needs to know about the folder's layout.
#[derive(Debug, Clone, Copy)]
pub struct Layout<'a> {
    /// The library's folder inside it.
    pub library: &'a str,
    /// The version history's folder inside it.
    pub history: &'a str,
    /// The recent-documents list inside it.
    pub recent: &'a str,
}

/// Where the data folder is: `named`, once `legacy` has been moved there if only `legacy` exists.
///
/// A folder that cannot be moved (a file in it held open by an older copy of the app still running) is used
/// where it is, and the move tried again on the next start. A `named` folder that already exists wins, even if
/// `legacy` exists too: that is a move made before, and a `legacy` that came back since is left alone.
pub fn settle(legacy: &Path, named: &Path, layout: Layout<'_>) -> Settled {
    if named.exists() || !legacy.exists() {
        return Settled { folder: named.to_path_buf(), moved: false };
    }
    if let Some(parent) = named.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::rename(legacy, named).is_err() {
        return Settled { folder: legacy.to_path_buf(), moved: false };
    }
    let _ = fix_recent(&named.join(layout.recent), legacy, named);
    fix_history(&named.join(layout.history), &legacy.join(layout.library), &named.join(layout.library));
    Settled { folder: named.to_path_buf(), moved: true }
}

/// `path` with `from` swapped for `to`, if it is `from` or inside it; whole components only.
pub fn rebase(path: &str, from: &Path, to: &Path) -> Option<String> {
    let rest = Path::new(path).strip_prefix(from).ok()?;
    Some(to.join(rest).to_string_lossy().into_owned())
}

/// Point the recent documents that were in the old folder at the new one.
fn fix_recent(file: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(_) => return Ok(()),
    };
    let mut list: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut changed = false;
    for entry in &mut list {
        let Some(path) = entry.get("path").and_then(|p| p.as_str()) else { continue };
        if let Some(moved) = rebase(path, from, to) {
            entry["path"] = serde_json::Value::String(moved);
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    let temp = file.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|e| e.to_string())?;
    fs::rename(&temp, file).map_err(|e| e.to_string())
}

/// Rename each library note's history folder from the hash of its old path to the hash of its new one.
fn fix_history(history_root: &Path, old_library: &Path, new_library: &Path) {
    if !history_root.is_dir() {
        return;
    }
    let mut notes = Vec::new();
    collect_notes(new_library, &mut notes);
    for note in notes {
        let Ok(relative) = note.strip_prefix(new_library) else { continue };
        let before = history::folder_for(history_root, &old_library.join(relative));
        let after = history::folder_for(history_root, &note);
        if before.is_dir() && !after.exists() {
            let _ = fs::rename(&before, &after);
        }
    }
}

fn collect_notes(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_notes(&path, out);
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(crate::library::NOTEX_EXTENSION)) {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAYOUT: Layout<'static> = Layout { library: "library", history: "history", recent: "recent.json" };

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn a_fresh_install_uses_the_named_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (legacy, named) = (dir.path().join("com.notex.app"), dir.path().join("KK-Notes"));
        assert_eq!(settle(&legacy, &named, LAYOUT), Settled { folder: named.clone(), moved: false });
        assert!(!legacy.exists());
    }

    #[test]
    fn the_old_folder_moves_with_everything_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let (legacy, named) = (dir.path().join("com.notex.app"), dir.path().join("KK-Notes"));
        write(&legacy.join("library/Maths/Algebra.notex"), "note");
        write(&legacy.join("drafts/autosave.notex"), "draft");
        write(&legacy.join("background.json"), "{}");

        assert_eq!(settle(&legacy, &named, LAYOUT), Settled { folder: named.clone(), moved: true });
        assert!(!legacy.exists());
        assert_eq!(fs::read_to_string(named.join("library/Maths/Algebra.notex")).unwrap(), "note");
        assert_eq!(fs::read_to_string(named.join("drafts/autosave.notex")).unwrap(), "draft");
        assert!(named.join("background.json").exists());
    }

    #[test]
    fn a_folder_moved_before_is_not_moved_again() {
        let dir = tempfile::tempdir().unwrap();
        let (legacy, named) = (dir.path().join("com.notex.app"), dir.path().join("KK-Notes"));
        write(&named.join("library/New.notex"), "new");
        write(&legacy.join("library/Old.notex"), "old");
        assert_eq!(settle(&legacy, &named, LAYOUT), Settled { folder: named.clone(), moved: false });
        assert!(legacy.join("library/Old.notex").exists());
        assert!(!named.join("library/Old.notex").exists());
    }

    #[test]
    fn recent_documents_in_the_library_follow_it_and_others_stay() {
        let dir = tempfile::tempdir().unwrap();
        let (legacy, named) = (dir.path().join("com.notex.app"), dir.path().join("KK-Notes"));
        let inside = legacy.join("library").join("Week 1.notex");
        let outside = dir.path().join("Desktop").join("Essay.notex");
        let recent = serde_json::json!([
            { "path": inside.to_string_lossy(), "title": "Week 1", "openedMs": 2 },
            { "path": outside.to_string_lossy(), "title": "Essay", "openedMs": 1 },
        ]);
        write(&legacy.join("recent.json"), &recent.to_string());
        write(&inside, "note");

        settle(&legacy, &named, LAYOUT);
        let list: Vec<serde_json::Value> =
            serde_json::from_str(&fs::read_to_string(named.join("recent.json")).unwrap()).unwrap();
        assert_eq!(list[0]["path"], named.join("library").join("Week 1.notex").to_string_lossy().as_ref());
        assert_eq!(list[0]["title"], "Week 1");
        assert_eq!(list[1]["path"], outside.to_string_lossy().as_ref());
    }

    #[test]
    fn a_library_note_keeps_its_version_history() {
        let dir = tempfile::tempdir().unwrap();
        let (legacy, named) = (dir.path().join("com.notex.app"), dir.path().join("KK-Notes"));
        let note = legacy.join("library").join("Maths").join("Algebra.notex");
        write(&note, "now");
        let kept = history::folder_for(&legacy.join("history"), &note);
        write(&kept.join("1000.notex"), "before");

        settle(&legacy, &named, LAYOUT);
        let moved_note = named.join("library").join("Maths").join("Algebra.notex");
        let found = history::folder_for(&named.join("history"), &moved_note);
        assert_eq!(fs::read_to_string(found.join("1000.notex")).unwrap(), "before");
    }

    #[test]
    fn rebasing_takes_whole_components_only() {
        let from = Path::new("/data/com.notex.app");
        let to = Path::new("/data/KK-Notes");
        assert_eq!(
            rebase("/data/com.notex.app/library/a.notex", from, to).as_deref(),
            Some(Path::new("/data/KK-Notes/library/a.notex").to_string_lossy().as_ref())
        );
        assert_eq!(rebase("/data/com.notex.application/a.notex", from, to), None);
        assert_eq!(rebase("/elsewhere/a.notex", from, to), None);
    }
}
