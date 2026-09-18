//! What to do about a file that changed.
//!
//! The decision is three-way, not two. Comparing the local copy against the
//! remote one only says *that* they differ, never which way to move: a file
//! edited here looks exactly like a file edited there. What distinguishes
//! them is the digest recorded at the last successful sync — the base. Against
//! that, one side having moved means copy it over, and both sides having moved
//! means ask.
//!
//! A two-way comparison is how sync tools silently eat a page of notes.

use serde::{Deserialize, Serialize};

use crate::digest::FileDigest;

/// What was true at the last successful sync of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    /// Path relative to the library root, `/`-separated on every platform.
    pub path: String,
    /// The content both sides agreed on last time.
    pub base_hash: String,
    pub synced_at_ms: u64,
}

/// What the engine should do with one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncAction {
    /// Both sides match the base; there is nothing to do.
    InSync,
    /// Only the local copy moved: upload it.
    Push,
    /// Only the remote copy moved: download it.
    Pull,
    /// Neither side has ever been synced, and only one has the file.
    PushNew,
    PullNew,
    /// Both sides moved to the same content. Nothing to transfer — just agree
    /// on the new base, so the next edit is judged against the right thing.
    Converged,
    /// Both sides moved, differently. The user decides.
    Conflict,
    /// The file is gone from both sides; drop the record.
    Forget,
    /// Deleted locally, unchanged remotely (or the reverse): propagate it.
    DeleteRemote,
    DeleteLocal,
    /// Deleted on one side and edited on the other. Deleting someone's edit
    /// without asking is the one thing a sync engine must never do, so this is
    /// a conflict too.
    DeleteConflict,
}

/// Decide what to do with one file from the three digests.
///
/// `base` is `None` for a file this device has never synced.
pub fn decide(local: Option<&FileDigest>, remote: Option<&FileDigest>, base: Option<&str>) -> SyncAction {
    match (local, remote, base) {
        (None, None, _) => SyncAction::Forget,

        // Never synced before: whichever side has it, the other should get it.
        (Some(_), None, None) => SyncAction::PushNew,
        (None, Some(_), None) => SyncAction::PullNew,
        (Some(l), Some(r), None) => {
            // Both created it independently. Identical content is a
            // coincidence worth taking; anything else is a genuine conflict.
            if l.same_content(r) {
                SyncAction::Converged
            } else {
                SyncAction::Conflict
            }
        }

        // Synced before, and now missing from one side. (Missing from both is
        // already handled above, whatever the base was.)
        (Some(l), None, Some(base)) => {
            if l.hash == base {
                SyncAction::DeleteLocal
            } else {
                SyncAction::DeleteConflict
            }
        }
        (None, Some(r), Some(base)) => {
            if r.hash == base {
                SyncAction::DeleteRemote
            } else {
                SyncAction::DeleteConflict
            }
        }

        (Some(l), Some(r), Some(base)) => {
            let local_moved = l.hash != base;
            let remote_moved = r.hash != base;
            match (local_moved, remote_moved) {
                (false, false) => SyncAction::InSync,
                (true, false) => SyncAction::Push,
                (false, true) => SyncAction::Pull,
                (true, true) => {
                    if l.same_content(r) {
                        SyncAction::Converged
                    } else {
                        SyncAction::Conflict
                    }
                }
            }
        }
    }
}

/// What the user chose in the conflict modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    KeepLocal,
    KeepRemote,
    /// Keep both: the remote copy lands beside the local one under a new name,
    /// and nobody's work is thrown away. The safe default when in doubt.
    KeepBoth,
}

/// The name a kept-both copy is filed under.
///
/// The device name goes in it because the whole point of the third option is
/// to be able to tell the two apart afterwards, and "copy 2" does not. The
/// extension is preserved so the copy is still a document the app will open.
pub fn resolve_name(original: &str, device: &str) -> String {
    let device = sanitise_device(device);
    let (stem, extension) = match original.rfind('.') {
        // A leading dot is a hidden file, not an extension.
        Some(index) if index > 0 => (&original[..index], &original[index..]),
        _ => (original, ""),
    };
    format!("{stem} (conflicted copy from {device}){extension}")
}

/// Strip whatever a file name cannot contain on Windows or POSIX, so a device
/// called `Kerim's / Tablet` still produces a writable name.
fn sanitise_device(device: &str) -> String {
    let cleaned: String = device
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "another device".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(content: &str) -> FileDigest {
        FileDigest::of_bytes(content.as_bytes(), 0)
    }

    fn hash_of(content: &str) -> String {
        digest(content).hash
    }

    #[test]
    fn nothing_to_do_when_both_sides_match_the_base() {
        let d = digest("v1");
        assert_eq!(decide(Some(&d), Some(&d), Some(&hash_of("v1"))), SyncAction::InSync);
    }

    #[test]
    fn one_side_moving_says_which_way_to_copy() {
        let base = hash_of("v1");
        let old = digest("v1");
        let new = digest("v2");
        assert_eq!(decide(Some(&new), Some(&old), Some(&base)), SyncAction::Push);
        assert_eq!(decide(Some(&old), Some(&new), Some(&base)), SyncAction::Pull);
    }

    #[test]
    fn both_sides_moving_differently_is_a_conflict() {
        let base = hash_of("v1");
        assert_eq!(
            decide(Some(&digest("local edit")), Some(&digest("remote edit")), Some(&base)),
            SyncAction::Conflict
        );
    }

    #[test]
    fn both_sides_reaching_the_same_content_is_not_a_conflict() {
        // Two devices that made the same edit have nothing to argue about;
        // the base just needs to catch up so the next edit is judged right.
        let base = hash_of("v1");
        let same = digest("v2");
        assert_eq!(decide(Some(&same), Some(&same), Some(&base)), SyncAction::Converged);
    }

    #[test]
    fn a_two_way_comparison_would_get_these_backwards() {
        // The local and remote digests are identical in both of these cases;
        // only the base distinguishes "I edited it" from "they edited it".
        let old = digest("v1");
        let new = digest("v2");
        assert_eq!(decide(Some(&new), Some(&old), Some(&hash_of("v1"))), SyncAction::Push);
        assert_eq!(decide(Some(&new), Some(&old), Some(&hash_of("v2"))), SyncAction::Pull);
    }

    #[test]
    fn a_file_neither_side_has_synced_goes_to_whichever_side_lacks_it() {
        let d = digest("new note");
        assert_eq!(decide(Some(&d), None, None), SyncAction::PushNew);
        assert_eq!(decide(None, Some(&d), None), SyncAction::PullNew);
    }

    #[test]
    fn two_devices_creating_the_same_name_independently_is_a_conflict() {
        assert_eq!(
            decide(Some(&digest("mine")), Some(&digest("theirs")), None),
            SyncAction::Conflict
        );
        let same = digest("identical");
        assert_eq!(decide(Some(&same), Some(&same), None), SyncAction::Converged);
    }

    #[test]
    fn a_deletion_propagates_only_when_the_other_side_is_untouched() {
        let base = hash_of("v1");
        let unchanged = digest("v1");
        let edited = digest("v2");
        // Deleted remotely, untouched locally: delete it here too.
        assert_eq!(decide(Some(&unchanged), None, Some(&base)), SyncAction::DeleteLocal);
        assert_eq!(decide(None, Some(&unchanged), Some(&base)), SyncAction::DeleteRemote);
        // Deleted on one side, edited on the other: never silently discard the
        // edit. This is the case that loses a page of notes if it is guessed.
        assert_eq!(decide(Some(&edited), None, Some(&base)), SyncAction::DeleteConflict);
        assert_eq!(decide(None, Some(&edited), Some(&base)), SyncAction::DeleteConflict);
    }

    #[test]
    fn a_file_that_is_gone_everywhere_is_forgotten() {
        assert_eq!(decide(None, None, None), SyncAction::Forget);
        assert_eq!(decide(None, None, Some(&hash_of("v1"))), SyncAction::Forget);
    }

    #[test]
    fn a_kept_both_copy_says_where_it_came_from() {
        assert_eq!(
            resolve_name("Week 1.notex", "Surface"),
            "Week 1 (conflicted copy from Surface).notex"
        );
    }

    #[test]
    fn keeping_both_survives_awkward_names() {
        // No extension at all.
        assert_eq!(resolve_name("Notes", "Tablet"), "Notes (conflicted copy from Tablet)");
        // A dotted name keeps only the real extension.
        assert_eq!(
            resolve_name("2026.01.notex", "Tablet"),
            "2026.01 (conflicted copy from Tablet).notex"
        );
        // A leading dot is a hidden file, not an extension.
        assert_eq!(resolve_name(".notex", "Tablet"), ".notex (conflicted copy from Tablet)");
    }

    #[test]
    fn a_device_name_cannot_produce_an_unwritable_file_name() {
        assert_eq!(
            resolve_name("a.notex", "Kerim's / Tablet: 2"),
            "a.notex".replace(".notex", " (conflicted copy from Kerim's - Tablet- 2).notex")
        );
        assert_eq!(resolve_name("a.notex", "   "), "a (conflicted copy from another device).notex");
        assert_eq!(resolve_name("a.notex", "..."), "a (conflicted copy from another device).notex");
    }
}
