//! The recycle bin: notes and folders deleted from the library go here rather than away.
//!
//! The bin is a folder *beside* the library, not inside it, so the library's listing, its search and its sync stop
//! seeing what is in it — to the cloud, a note in the bin is deleted, and one restored is a new file. Each thing in
//! it has a folder of its own, `<bin>/<id>/`, holding it under its own name and, in `item.json`, what it was and
//! where in the library it came from, so it can be put back there. What has been in the bin longer than
//! [`KEEP_DAYS`] goes for good the next time the bin is looked at.
//!
//! Copying notes (and folders, with what is in them) is here too: it is the other thing done to a selection of them.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::library::{relative_to, unique_path, within_root, NOTEX_EXTENSION};

/// How long something stays in the bin before it goes for good.
pub const KEEP_DAYS: u64 = 30;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const META: &str = "item.json";

/// Something in the bin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// Its folder in the bin, and how it is asked for.
    pub id: String,
    /// The note's name (without `.notex`), or the folder's.
    pub name: String,
    pub is_folder: bool,
    /// Where it was in the library: `/`-separated, its own file name last.
    pub original: String,
    pub deleted_ms: u64,
    pub bytes: u64,
    /// The notes in it: one for a note.
    pub count: u32,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_string())
}

/// An id is a folder name the bin made: digits, letters and dashes. Anything else is refused rather than joined
/// to a path, so no id can reach outside the bin.
fn item_dir(bin: &Path, id: &str) -> io::Result<PathBuf> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(invalid("That is not something in the recycle bin"));
    }
    Ok(bin.join(id))
}

/// Move a file or a folder, across drives too: a rename where it can be, a copy and a delete where it cannot.
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_path(from, to)?;
    if from.is_dir() {
        fs::remove_dir_all(from)
    } else {
        fs::remove_file(from)
    }
}

/// Copy a file, or a folder and everything in it.
fn copy_path(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_path(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

fn is_notex(path: &Path) -> bool {
    path.extension().map(|e| e.eq_ignore_ascii_case(NOTEX_EXTENSION)).unwrap_or(false)
}

/// The bytes and the notes a file or a folder holds.
fn measure(path: &Path) -> (u64, u32) {
    if path.is_dir() {
        fs::read_dir(path)
            .map(|entries| {
                entries.flatten().fold((0, 0), |(bytes, count), entry| {
                    let (b, c) = measure(&entry.path());
                    (bytes + b, count + c)
                })
            })
            .unwrap_or((0, 0))
    } else {
        let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        (bytes, u32::from(is_notex(path)))
    }
}

fn display_name(file_name: &str, is_folder: bool) -> String {
    if is_folder {
        return file_name.to_string();
    }
    let suffix = format!(".{NOTEX_EXTENSION}");
    if file_name.len() > suffix.len() && file_name[file_name.len() - suffix.len()..].eq_ignore_ascii_case(&suffix) {
        file_name[..file_name.len() - suffix.len()].to_string()
    } else {
        file_name.to_string()
    }
}

/// A new folder in the bin, named for when, and unique.
fn new_item_dir(bin: &Path, now_ms: u64) -> io::Result<(String, PathBuf)> {
    fs::create_dir_all(bin)?;
    for n in 0..10_000u32 {
        let id = if n == 0 { format!("{now_ms}") } else { format!("{now_ms}-{n}") };
        let dir = bin.join(&id);
        match fs::create_dir(&dir) {
            Ok(()) => return Ok((id, dir)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("The recycle bin has no room for another item"))
}

/// Move notes and folders of the library into the bin. All or nothing per item: one that cannot be moved is left
/// where it was, and the error says so; the ones before it are in the bin.
pub fn trash_entries(root: &Path, bin: &Path, paths: &[PathBuf], now_ms: u64) -> io::Result<Vec<TrashItem>> {
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if !within_root(root, path) || path.canonicalize().map(|p| p == canonical_root).unwrap_or(false) {
            return Err(invalid("Only notes and folders in the library go to the recycle bin"));
        }
        if !path.exists() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "That is no longer in the library"));
        }
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| invalid("Nothing to delete"))?;
        let is_folder = path.is_dir();
        let (bytes, count) = measure(path);
        let (id, dir) = new_item_dir(bin, now_ms)?;
        let item = TrashItem {
            id,
            name: display_name(&file_name, is_folder),
            is_folder,
            original: relative_to(root, path),
            deleted_ms: now_ms,
            bytes,
            count,
        };
        let written = serde_json::to_vec_pretty(&item).map_err(io::Error::other).and_then(|json| fs::write(dir.join(META), json));
        if let Err(e) = written.and_then(|()| move_path(path, &dir.join(&file_name))) {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
        items.push(item);
    }
    Ok(items)
}

/// What is in the bin, the most recently deleted first. What has been there longer than [`KEEP_DAYS`] goes now.
pub fn list_trash(bin: &Path, now_ms: u64) -> io::Result<Vec<TrashItem>> {
    let Ok(entries) = fs::read_dir(bin) else { return Ok(Vec::new()) };
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(text) = fs::read(dir.join(META)) else { continue };
        let Ok(item) = serde_json::from_slice::<TrashItem>(&text) else { continue };
        if now_ms.saturating_sub(item.deleted_ms) > KEEP_DAYS * DAY_MS {
            let _ = fs::remove_dir_all(&dir);
            continue;
        }
        // The folder's own name is the id: an `item.json` copied from elsewhere does not get to name another.
        if entry.file_name().to_string_lossy() != item.id {
            continue;
        }
        items.push(item);
    }
    items.sort_by(|a, b| b.deleted_ms.cmp(&a.deleted_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(items)
}

/// Where in the library something goes back to: where it was, if that is a plain path inside the library, or the
/// library's top level under its own name.
fn restore_target(root: &Path, original: &str, file_name: &str) -> PathBuf {
    let relative = Path::new(original);
    let plain = !original.is_empty() && relative.components().all(|c| matches!(c, Component::Normal(_)));
    if plain {
        root.join(relative)
    } else {
        root.join(file_name)
    }
}

/// Put things back where they were in the library, folders that have gone since made again; a name taken there
/// meanwhile gets a number. Returns where each went.
pub fn restore(root: &Path, bin: &Path, ids: &[String]) -> io::Result<Vec<PathBuf>> {
    let mut restored = Vec::with_capacity(ids.len());
    for id in ids {
        let dir = item_dir(bin, id)?;
        let item: TrashItem = serde_json::from_slice(&fs::read(dir.join(META))?).map_err(io::Error::other)?;
        let held = fs::read_dir(&dir)?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.file_name().map(|n| n != META).unwrap_or(false))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "That item in the recycle bin is empty"))?;
        let file_name = held.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut target = restore_target(root, &item.original, &file_name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        if !within_root(root, &target) {
            target = root.join(&file_name);
        }
        let target = unique_path(&target);
        move_path(&held, &target)?;
        fs::remove_dir_all(&dir)?;
        restored.push(target);
    }
    Ok(restored)
}

/// Delete things in the bin for good.
pub fn delete_forever(bin: &Path, ids: &[String]) -> io::Result<()> {
    for id in ids {
        let dir = item_dir(bin, id)?;
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
    }
    Ok(())
}

/// Delete everything in the bin for good.
pub fn empty(bin: &Path) -> io::Result<()> {
    let Ok(entries) = fs::read_dir(bin) else { return Ok(()) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// Copy notes and folders of the library beside themselves, each copy named like it with a number. Returns the
/// copies' paths.
pub fn copy_entries(root: &Path, paths: &[PathBuf]) -> io::Result<Vec<PathBuf>> {
    let mut copies = Vec::with_capacity(paths.len());
    for path in paths {
        if !within_root(root, path) || !path.exists() {
            return Err(invalid("Only notes and folders in the library can be copied"));
        }
        let target = unique_path(path);
        if target.starts_with(path) {
            return Err(invalid("A folder cannot be copied inside itself"));
        }
        copy_path(path, &target)?;
        copies.push(target);
    }
    Ok(copies)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let bin = dir.path().join("trash");
        fs::create_dir_all(&root).unwrap();
        (dir, root, bin)
    }

    fn note(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn a_note_goes_to_the_bin_and_comes_back_where_it_was() {
        let (_dir, root, bin) = library();
        let path = root.join("Week 1").join("Lecture.notex");
        note(&path, "{}");
        let items = trash_entries(&root, &bin, std::slice::from_ref(&path), 1_000).unwrap();
        assert!(!path.exists());
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.name, "Lecture");
        assert_eq!(item.original, "Week 1/Lecture.notex");
        assert_eq!((item.is_folder, item.count, item.bytes), (false, 1, 2));
        assert_eq!(list_trash(&bin, 2_000).unwrap(), items);

        let back = restore(&root, &bin, std::slice::from_ref(&item.id)).unwrap();
        assert_eq!(back, vec![path.clone()]);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
        assert!(list_trash(&bin, 3_000).unwrap().is_empty());
    }

    #[test]
    fn a_folder_goes_with_what_is_in_it_and_comes_back_whole() {
        let (_dir, root, bin) = library();
        note(&root.join("Course").join("a.notex"), "aa");
        note(&root.join("Course").join("Inner").join("b.notex"), "bbb");
        let items = trash_entries(&root, &bin, &[root.join("Course")], 5).unwrap();
        assert_eq!((items[0].is_folder, items[0].count, items[0].bytes), (true, 2, 5));
        assert!(!root.join("Course").exists());
        restore(&root, &bin, &[items[0].id.clone()]).unwrap();
        assert_eq!(fs::read_to_string(root.join("Course").join("Inner").join("b.notex")).unwrap(), "bbb");
    }

    #[test]
    fn coming_back_makes_the_folder_again_and_never_overwrites() {
        let (_dir, root, bin) = library();
        let path = root.join("Gone").join("Note.notex");
        note(&path, "old");
        let items = trash_entries(&root, &bin, std::slice::from_ref(&path), 5).unwrap();
        fs::remove_dir_all(root.join("Gone")).unwrap();
        // Meanwhile another note took the name.
        note(&path, "new");
        let back = restore(&root, &bin, &[items[0].id.clone()]).unwrap();
        assert_eq!(back[0], root.join("Gone").join("Note (2).notex"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_to_string(&back[0]).unwrap(), "old");
    }

    #[test]
    fn things_deleted_together_stay_apart_and_newest_come_first() {
        let (_dir, root, bin) = library();
        note(&root.join("a.notex"), "a");
        note(&root.join("b.notex"), "b");
        note(&root.join("c.notex"), "c");
        let first = trash_entries(&root, &bin, &[root.join("a.notex"), root.join("b.notex")], 10).unwrap();
        assert_ne!(first[0].id, first[1].id);
        trash_entries(&root, &bin, &[root.join("c.notex")], 20).unwrap();
        let names: Vec<_> = list_trash(&bin, 30).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["c", "a", "b"]);
    }

    #[test]
    fn what_has_been_in_the_bin_a_month_goes_for_good() {
        let (_dir, root, bin) = library();
        note(&root.join("old.notex"), "x");
        note(&root.join("new.notex"), "y");
        trash_entries(&root, &bin, &[root.join("old.notex")], 0).unwrap();
        trash_entries(&root, &bin, &[root.join("new.notex")], 20 * DAY_MS).unwrap();
        let left: Vec<_> = list_trash(&bin, KEEP_DAYS * DAY_MS + 1).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(left, ["new"]);
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 1);
    }

    #[test]
    fn deleting_for_good_and_emptying() {
        let (_dir, root, bin) = library();
        for name in ["a", "b", "c"] {
            note(&root.join(format!("{name}.notex")), name);
        }
        let items = trash_entries(&root, &bin, &[root.join("a.notex"), root.join("b.notex"), root.join("c.notex")], 1).unwrap();
        delete_forever(&bin, &[items[0].id.clone()]).unwrap();
        assert_eq!(list_trash(&bin, 2).unwrap().len(), 2);
        empty(&bin).unwrap();
        assert!(list_trash(&bin, 3).unwrap().is_empty());
    }

    #[test]
    fn nothing_outside_the_library_or_the_bin_is_touched() {
        let (dir, root, bin) = library();
        let outside = dir.path().join("elsewhere.notex");
        note(&outside, "keep");
        assert!(trash_entries(&root, &bin, std::slice::from_ref(&outside), 1).is_err());
        assert!(trash_entries(&root, &bin, std::slice::from_ref(&root), 1).is_err());
        assert!(outside.exists());
        assert!(delete_forever(&bin, &["../library".to_string()]).is_err());
        assert!(restore(&root, &bin, &["a/b".to_string()]).is_err());
    }

    #[test]
    fn an_item_whose_record_points_outside_the_library_comes_back_at_its_top() {
        let (_dir, root, bin) = library();
        note(&root.join("Note.notex"), "n");
        let items = trash_entries(&root, &bin, &[root.join("Note.notex")], 1).unwrap();
        let dir = bin.join(&items[0].id);
        let mut tampered = items[0].clone();
        tampered.original = "../../escape/Note.notex".to_string();
        fs::write(dir.join(META), serde_json::to_vec(&tampered).unwrap()).unwrap();
        let back = restore(&root, &bin, &[items[0].id.clone()]).unwrap();
        assert_eq!(back[0], root.join("Note.notex"));
    }

    #[test]
    fn copies_sit_beside_their_originals_with_a_number() {
        let (_dir, root, _bin) = library();
        note(&root.join("Lecture.notex"), "l");
        note(&root.join("Course").join("a.notex"), "a");
        let copies = copy_entries(&root, &[root.join("Lecture.notex"), root.join("Course")]).unwrap();
        assert_eq!(copies, vec![root.join("Lecture (2).notex"), root.join("Course (2)")]);
        assert_eq!(fs::read_to_string(root.join("Course (2)").join("a.notex")).unwrap(), "a");
        assert_eq!(fs::read_to_string(root.join("Lecture.notex")).unwrap(), "l");
    }
}
