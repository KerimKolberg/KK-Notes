//! Earlier versions of a note, kept when it is saved over.
//!
//! Saving replaces the file, so a mistake that was saved — a page erased, a
//! selection deleted and then Ctrl+S — was gone. Before a save overwrites a
//! document, the file as it stands is copied into a folder of its own, named by
//! when that version was last saved (the file's modified time), and the oldest
//! are let go on a schedule that keeps more of the recent past than the distant
//! one. Nothing here knows about the document's format beyond reading a title
//! and a page count for the list, which it borrows from the thumbnail reader.
//!
//! The copies live in the app's own data folder, not in the library, so they are
//! neither shown as notes nor synced to Drive.

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;

use crate::{digest::hash_bytes, thumb};

/// Every save in the last hour is a candidate, but two closer together than this are one.
pub const FINE_MS: u64 = 5 * 60 * 1000;
/// Up to a day old, one version an hour is kept.
pub const HOUR_MS: u64 = 60 * 60 * 1000;
/// Beyond that, one a day, until they are this old.
pub const DAY_MS: u64 = 24 * HOUR_MS;
pub const KEEP_DAYS: u64 = 60;
/// However the schedule falls, no more than this many are kept …
pub const MAX_VERSIONS: usize = 40;
/// … and, past the newest, no more than this many bytes in all (PDFs embed in a note).
pub const MAX_BYTES: u64 = 400 * 1024 * 1024;

const EXTENSION: &str = "notex";

/// One kept version, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    /// When this version was saved, in milliseconds since the epoch. Names it, too.
    pub id: u64,
    pub bytes: u64,
    pub title: String,
    pub page_count: u32,
}

/// The folder that holds one document's versions, inside `root`.
///
/// Named by a hash of the document's path, so any path is a safe folder name, and so the
/// history belongs to where a note lives (moving a note to another folder starts it afresh).
pub fn folder_for(root: &Path, document: &Path) -> PathBuf {
    let key = hash_bytes(document.to_string_lossy().as_bytes());
    root.join(&key[..24])
}

fn file_for(folder: &Path, id: u64) -> PathBuf {
    folder.join(format!("{id}.{EXTENSION}"))
}

fn modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// The ids of what is kept, newest first.
fn ids(folder: &Path) -> Vec<u64> {
    let Ok(read) = fs::read_dir(folder) else { return Vec::new() };
    let mut out: Vec<u64> = read
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
                return None;
            }
            path.file_stem()?.to_str()?.parse::<u64>().ok()
        })
        .collect();
    out.sort_unstable_by(|a, b| b.cmp(a));
    out
}

/// Keep `document` as it stands, before it is written over. Returns the new version's id, or
/// `None` when nothing was kept: no file yet, the same content as the newest version, or a
/// version saved too soon after the newest to be worth a copy.
pub fn snapshot(folder: &Path, document: &Path, now_ms: u64) -> Result<Option<u64>, String> {
    keep(folder, document, now_ms, true)
}

/// Like [`snapshot`], but without the rule about saves close together: for when a version must
/// be there (a restore is about to replace the file, and what it replaces has to be recoverable).
pub fn snapshot_always(folder: &Path, document: &Path, now_ms: u64) -> Result<Option<u64>, String> {
    keep(folder, document, now_ms, false)
}

fn keep(folder: &Path, document: &Path, now_ms: u64, respect_gap: bool) -> Result<Option<u64>, String> {
    let Some(id) = modified_ms(document) else { return Ok(None) };
    let known = ids(folder);
    if known.contains(&id) {
        return Ok(None);
    }
    if let Some(&newest) = known.first() {
        if respect_gap && id.abs_diff(newest) < FINE_MS {
            return Ok(None);
        }
        // The same words again (a file saved without a change) are not a new version.
        let newest_path = file_for(folder, newest);
        if let (Ok(a), Ok(b)) = (fs::metadata(document), fs::metadata(&newest_path)) {
            if a.len() == b.len() {
                if let (Ok(x), Ok(y)) = (fs::read(document), fs::read(&newest_path)) {
                    if x == y {
                        return Ok(None);
                    }
                }
            }
        }
    }
    fs::create_dir_all(folder).map_err(|e| format!("Cannot create {}: {e}", folder.display()))?;
    let target = file_for(folder, id);
    let tmp = folder.join(format!(".{id}.tmp"));
    fs::copy(document, &tmp).map_err(|e| format!("Cannot keep a copy of {}: {e}", document.display()))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot keep a copy of {}: {e}", document.display())
    })?;
    prune(folder, now_ms);
    Ok(Some(id))
}

/// Let go of what the schedule no longer wants: versions older than `KEEP_DAYS`; all but the
/// newest in each five-minute window of the last hour, hour of the last day and day after that;
/// then the oldest until there are few enough and they are small enough.
pub fn prune(folder: &Path, now_ms: u64) {
    let mut kept: Vec<u64> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // Newest first, so the first in a window is the newest in it.
    for id in ids(folder) {
        let age = now_ms.saturating_sub(id);
        let window = if age < HOUR_MS {
            (0u8, id / FINE_MS)
        } else if age < DAY_MS {
            (1, id / HOUR_MS)
        } else {
            (2, id / DAY_MS)
        };
        let too_old = age > KEEP_DAYS * DAY_MS;
        if too_old || !seen.insert(window) {
            let _ = fs::remove_file(file_for(folder, id));
        } else {
            kept.push(id);
        }
    }
    let mut total: u64 = 0;
    for (n, &id) in kept.iter().enumerate() {
        let size = fs::metadata(file_for(folder, id)).map(|m| m.len()).unwrap_or(0);
        total += size;
        // The newest is always kept, however large.
        if n > 0 && (n >= MAX_VERSIONS || total > MAX_BYTES) {
            let _ = fs::remove_file(file_for(folder, id));
        }
    }
}

/// What is kept, newest first, each with its title and page count.
pub fn list(folder: &Path) -> Vec<VersionInfo> {
    ids(folder)
        .into_iter()
        .filter_map(|id| {
            let path = file_for(folder, id);
            let bytes = fs::metadata(&path).ok()?.len();
            let (title, page_count) = match thumb::read_thumbnail_source(&path, "") {
                Ok(head) => (head.title, head.page_count),
                // A copy that no longer reads is still listed, so it can be seen and not trusted.
                Err(_) => (String::new(), 0),
            };
            Some(VersionInfo { id, bytes, title, page_count })
        })
        .collect()
}

/// The path of one kept version, if it is there.
pub fn version_path(folder: &Path, id: u64) -> Option<PathBuf> {
    let path = file_for(folder, id);
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const MIN: u64 = 60 * 1000;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notes-sync-history-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn note(title: &str, pages: usize) -> String {
        let page = r#"{"id":"p","strokes":[]}"#;
        let body = vec![page; pages].join(",");
        format!(r#"{{"format":"notex","document":{{"title":"{title}","pages":[{body}]}}}}"#)
    }

    /// Write a document whose modified time is `at_ms`.
    fn write_at(path: &Path, text: &str, at_ms: u64) {
        fs::write(path, text).unwrap();
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(at_ms)).unwrap();
    }

    const T0: u64 = 1_700_000_000_000;

    #[test]
    fn the_folder_is_the_documents_own() {
        let root = Path::new("/h");
        assert_eq!(folder_for(root, Path::new("/a/b.notex")), folder_for(root, Path::new("/a/b.notex")));
        assert_ne!(folder_for(root, Path::new("/a/b.notex")), folder_for(root, Path::new("/a/c.notex")));
        assert!(folder_for(root, Path::new("/../../etc/passwd")).starts_with(root));
    }

    #[test]
    fn nothing_is_kept_of_a_file_that_is_not_there_yet() {
        let dir = scratch("none");
        assert_eq!(snapshot(&dir.join("h"), &dir.join("new.notex"), T0).unwrap(), None);
        assert!(list(&dir.join("h")).is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_version_is_named_for_when_it_was_saved_and_listed_with_its_title() {
        let dir = scratch("one");
        let doc = dir.join("n.notex");
        write_at(&doc, &note("First", 2), T0);
        let folder = dir.join("h");
        assert_eq!(snapshot(&folder, &doc, T0 + 10 * MIN).unwrap(), Some(T0));
        let versions = list(&folder);
        assert_eq!(versions.len(), 1);
        assert_eq!((versions[0].id, versions[0].title.as_str(), versions[0].page_count), (T0, "First", 2));
        assert!(version_path(&folder, T0).is_some());
        assert!(version_path(&folder, T0 + 1).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_same_version_is_kept_once_and_so_is_the_same_content() {
        let dir = scratch("dup");
        let doc = dir.join("n.notex");
        let folder = dir.join("h");
        write_at(&doc, &note("A", 1), T0);
        assert_eq!(snapshot(&folder, &doc, T0).unwrap(), Some(T0));
        // The very file again.
        assert_eq!(snapshot(&folder, &doc, T0).unwrap(), None);
        // Saved again later without a change: same words, not a new version.
        write_at(&doc, &note("A", 1), T0 + 30 * MIN);
        assert_eq!(snapshot(&folder, &doc, T0 + 31 * MIN).unwrap(), None);
        assert_eq!(list(&folder).len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn saves_a_few_minutes_apart_are_one_version() {
        let dir = scratch("gap");
        let doc = dir.join("n.notex");
        let folder = dir.join("h");
        write_at(&doc, &note("A", 1), T0);
        snapshot(&folder, &doc, T0 + MIN).unwrap();
        write_at(&doc, &note("B", 1), T0 + 2 * MIN);
        assert_eq!(snapshot(&folder, &doc, T0 + 3 * MIN).unwrap(), None);
        write_at(&doc, &note("C", 1), T0 + 8 * MIN);
        assert_eq!(snapshot(&folder, &doc, T0 + 9 * MIN).unwrap(), Some(T0 + 8 * MIN));
        let titles: Vec<String> = list(&folder).into_iter().map(|v| v.title).collect();
        assert_eq!(titles, vec!["C", "A"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_forced_copy_ignores_how_close_the_last_one_was() {
        let dir = scratch("force");
        let doc = dir.join("n.notex");
        let folder = dir.join("h");
        write_at(&doc, &note("A", 1), T0);
        snapshot(&folder, &doc, T0).unwrap();
        write_at(&doc, &note("B", 1), T0 + MIN);
        assert_eq!(snapshot(&folder, &doc, T0 + 2 * MIN).unwrap(), None);
        assert_eq!(snapshot_always(&folder, &doc, T0 + 2 * MIN).unwrap(), Some(T0 + MIN));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn older_versions_thin_out_to_one_an_hour_then_one_a_day() {
        let dir = scratch("thin");
        let folder = dir.join("h");
        fs::create_dir_all(&folder).unwrap();
        let now = T0 + 10 * DAY_MS;
        // Four versions inside one hour three days ago, two more on another day, and one recent.
        let three_days = now - 3 * DAY_MS;
        let hour_start = three_days - three_days % HOUR_MS;
        let day_start = (now - 6 * DAY_MS) - (now - 6 * DAY_MS) % DAY_MS;
        // And two inside one hour, three hours ago, where the schedule still keeps an hour apart.
        let three_hours = now - 3 * HOUR_MS;
        let hour_three = three_hours - three_hours % HOUR_MS;
        let ids_in = [
            hour_three + 10 * MIN,
            hour_three + 20 * MIN,
            hour_start + 10 * MIN,
            hour_start + 20 * MIN,
            hour_start + 30 * MIN,
            hour_start + 40 * MIN,
            day_start + 2 * HOUR_MS,
            day_start + 5 * HOUR_MS,
            now - 2 * MIN,
        ];
        for id in ids_in {
            fs::write(file_for(&folder, id), note("x", 1)).unwrap();
        }
        prune(&folder, now);
        let left = ids(&folder);
        // Three days ago and six days ago are both days of their own: one each, the newest of each.
        assert_eq!(left, vec![now - 2 * MIN, hour_three + 20 * MIN, hour_start + 40 * MIN, day_start + 5 * HOUR_MS]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn what_is_too_old_is_let_go() {
        let dir = scratch("old");
        let folder = dir.join("h");
        fs::create_dir_all(&folder).unwrap();
        let now = T0 + 100 * DAY_MS;
        fs::write(file_for(&folder, now - 70 * DAY_MS), note("ancient", 1)).unwrap();
        fs::write(file_for(&folder, now - 10 * DAY_MS), note("recent", 1)).unwrap();
        prune(&folder, now);
        assert_eq!(ids(&folder), vec![now - 10 * DAY_MS]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_count_limit_drops_the_oldest_and_keeps_the_newest() {
        let dir = scratch("count");
        let folder = dir.join("h");
        fs::create_dir_all(&folder).unwrap();
        let now = T0 + 100 * DAY_MS;
        // One a day for fifty days.
        for d in 1..=50u64 {
            fs::write(file_for(&folder, now - d * DAY_MS), note("d", 1)).unwrap();
        }
        prune(&folder, now);
        let left = ids(&folder);
        assert_eq!(left.len(), MAX_VERSIONS);
        assert_eq!(left[0], now - DAY_MS);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_copy_that_will_not_read_is_still_listed() {
        let dir = scratch("bad");
        let folder = dir.join("h");
        fs::create_dir_all(&folder).unwrap();
        fs::write(file_for(&folder, T0), "not a note").unwrap();
        let versions = list(&folder);
        assert_eq!((versions.len(), versions[0].page_count, versions[0].title.as_str()), (1, 0, ""));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn files_that_are_not_versions_are_ignored() {
        let dir = scratch("junk");
        let folder = dir.join("h");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("readme.txt"), "x").unwrap();
        fs::write(folder.join("abc.notex"), "x").unwrap();
        fs::write(folder.join(".123.tmp"), "x").unwrap();
        assert!(ids(&folder).is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
