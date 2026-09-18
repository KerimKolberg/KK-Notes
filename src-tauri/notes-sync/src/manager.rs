//! The background sync engine: watch, decide, report.
//!
//! The manager owns three things — a filesystem watcher over the library, the
//! record of what each file looked like at its last successful sync, and a
//! `CloudProvider` to move bytes. It turns "a file changed" into one of the
//! actions in [`crate::conflict`], performs the unambiguous ones, and parks
//! the rest for the user to answer.
//!
//! It never resolves a conflict on its own. Picking newest-wins is what makes
//! sync engines untrustworthy: the file with the later timestamp is not
//! reliably the one with the work in it, and the loser is usually gone for
//! good.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    time::Duration,
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::{
    conflict::{decide, resolve_name, ConflictResolution, SyncAction, SyncRecord},
    digest::{now_ms, FileDigest},
    library::{relative_to, unique_path, NOTEX_EXTENSION},
    provider::{CloudProvider, OfflineProvider},
};

/// How long to wait for a burst of writes to settle before acting.
///
/// An atomic save is a create, a write, a flush and a rename — four events for
/// one edit — and the autosave fires every second and a half while someone is
/// writing. Without a quiet period the engine would upload a document mid-save
/// and then immediately upload it again.
pub const SETTLE: Duration = Duration::from_millis(1_500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    /// No account connected, or the network is gone.
    Offline,
    Syncing,
    UpToDate,
    /// At least one file needs an answer before anything else can finish.
    Conflicted,
    Error,
}

/// What the status indicator in the library's top bar shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: SyncPhase,
    /// The provider's display name.
    pub provider: String,
    /// Files still to be pushed or pulled.
    pub pending: u32,
    /// Files waiting on the user, by relative path.
    pub conflicts: Vec<String>,
    /// Unix epoch ms of the last completed pass, or 0 if there has not been one.
    pub last_synced_ms: u64,
    /// Set when `phase` is `Error`.
    pub message: Option<String>,
}

impl SyncStatus {
    fn offline(provider: &str) -> Self {
        Self {
            phase: SyncPhase::Offline,
            provider: provider.to_string(),
            pending: 0,
            conflicts: Vec::new(),
            last_synced_ms: 0,
            message: None,
        }
    }
}

/// Persisted between runs: what each file looked like when it last agreed.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub records: HashMap<String, SyncRecord>,
    pub last_synced_ms: u64,
}

pub struct SyncManager {
    root: PathBuf,
    device: String,
    provider: Mutex<Box<dyn CloudProvider>>,
    state: Mutex<SyncState>,
    status: Mutex<SyncStatus>,
    /// Set by the watcher thread, cleared by a pass. The watcher does no work
    /// itself: it only says that something moved.
    dirty: Arc<AtomicBool>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl SyncManager {
    pub fn new(root: PathBuf, device: impl Into<String>) -> Self {
        let provider: Box<dyn CloudProvider> = Box::new(OfflineProvider);
        let status = SyncStatus::offline(provider.name());
        Self {
            root,
            device: device.into(),
            provider: Mutex::new(provider),
            state: Mutex::new(SyncState::default()),
            status: Mutex::new(status),
            dirty: Arc::new(AtomicBool::new(false)),
            watcher: Mutex::new(None),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Swap in a real backend once an account is connected.
    pub fn set_provider(&self, provider: Box<dyn CloudProvider>) {
        let name = provider.name().to_string();
        *self.provider.lock().unwrap() = provider;
        let mut status = self.status.lock().unwrap();
        status.provider = name;
        status.phase = SyncPhase::Offline;
    }

    pub fn status(&self) -> SyncStatus {
        self.status.lock().unwrap().clone()
    }

    /// True when the watcher has seen a change that no pass has answered yet.
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
    }

    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::SeqCst);
    }

    /// Start watching the library. The receiver yields once per settled burst,
    /// so a caller can drive a pass without polling.
    ///
    /// Watching is best-effort by nature: every platform backend has a window
    /// where a file created inside a directory that was itself just created
    /// can land before the recursive watch reaches it, and inotify silently
    /// drops events when its queue overflows. So this is an optimisation —
    /// it makes sync feel immediate — and never the only trigger. The
    /// frontend also asks for a pass when the library is opened, which
    /// reconciles anything the watcher missed.
    pub fn watch(&self) -> notify::Result<Receiver<()>> {
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(raw_tx)?;
        fs::create_dir_all(&self.root).ok();
        watcher.watch(&self.root, RecursiveMode::Recursive)?;
        *self.watcher.lock().unwrap() = Some(watcher);

        let (tx, rx) = mpsc::channel::<()>();
        let dirty = Arc::clone(&self.dirty);
        std::thread::spawn(move || {
            while let Ok(event) = raw_rx.recv() {
                let Ok(event) = event else { continue };
                if !touches_documents(&event) {
                    continue;
                }
                dirty.store(true, Ordering::SeqCst);
                // Swallow the rest of the burst: an atomic save is four events
                // and the autosave repeats while the pen is moving.
                while raw_rx.recv_timeout(SETTLE).is_ok() {}
                if tx.send(()).is_err() {
                    return;
                }
            }
        });
        Ok(rx)
    }

    pub fn stop_watching(&self) {
        *self.watcher.lock().unwrap() = None;
    }

    /// Every `.notex` in the library, by relative path.
    pub fn scan_local(&self) -> HashMap<String, FileDigest> {
        let mut out = HashMap::new();
        collect(&self.root, &self.root, &mut out);
        out
    }

    /// Work out what each file needs, without doing any of it.
    pub fn plan(&self) -> Result<Vec<(String, SyncAction)>, String> {
        let local = self.scan_local();
        let remote: HashMap<String, FileDigest> = self
            .provider
            .lock()
            .unwrap()
            .list()?
            .into_iter()
            .map(|file| (file.path, file.digest))
            .collect();
        let state = self.state.lock().unwrap();

        let mut paths: Vec<String> = local.keys().chain(remote.keys()).chain(state.records.keys()).cloned().collect();
        paths.sort();
        paths.dedup();

        Ok(paths
            .into_iter()
            .map(|path| {
                let action = decide(
                    local.get(&path),
                    remote.get(&path),
                    state.records.get(&path).map(|r| r.base_hash.as_str()),
                );
                (path, action)
            })
            .filter(|(_, action)| !matches!(action, SyncAction::Forget))
            .collect())
    }

    /// Run one pass: perform everything unambiguous, park the conflicts.
    pub fn sync_once(&self) -> SyncStatus {
        self.dirty.store(false, Ordering::SeqCst);
        if !self.provider.lock().unwrap().is_connected() {
            let name = self.provider.lock().unwrap().name().to_string();
            let mut status = self.status.lock().unwrap();
            *status = SyncStatus::offline(&name);
            return status.clone();
        }
        self.set_phase(SyncPhase::Syncing);

        let plan = match self.plan() {
            Ok(plan) => plan,
            Err(message) => return self.fail(message),
        };

        let mut conflicts = Vec::new();
        let mut pending = 0_u32;
        for (path, action) in plan {
            match action {
                SyncAction::InSync | SyncAction::Forget => {}
                SyncAction::Conflict | SyncAction::DeleteConflict => conflicts.push(path),
                SyncAction::Converged => {
                    if let Err(message) = self.rebase(&path) {
                        return self.fail(message);
                    }
                }
                _ => {
                    pending += 1;
                    if let Err(message) = self.perform(&path, action) {
                        return self.fail(message);
                    }
                    pending -= 1;
                }
            }
        }

        let synced_at = now_ms();
        self.state.lock().unwrap().last_synced_ms = synced_at;
        let mut status = self.status.lock().unwrap();
        status.phase = if conflicts.is_empty() { SyncPhase::UpToDate } else { SyncPhase::Conflicted };
        status.pending = pending;
        status.conflicts = conflicts;
        status.last_synced_ms = synced_at;
        status.message = None;
        status.clone()
    }

    /// Answer one conflict.
    ///
    /// `KeepBoth` writes the remote copy in beside the local one under a name
    /// that says where it came from, and uploads it too, so both devices end
    /// up holding both versions. It is the only one of the three that cannot
    /// lose work, which is why the UI leads with it.
    pub fn resolve(&self, path: &str, choice: ConflictResolution) -> Result<SyncStatus, String> {
        let local_path = self.absolute(path)?;
        let provider = self.provider.lock().unwrap();
        match choice {
            ConflictResolution::KeepLocal => {
                let bytes = fs::read(&local_path).map_err(|e| format!("Cannot read {path}: {e}"))?;
                let digest = provider.upload(path, &bytes)?;
                drop(provider);
                self.record(path, &digest.hash);
            }
            ConflictResolution::KeepRemote => {
                let bytes = provider.fetch(path)?;
                drop(provider);
                write_atomic(&local_path, &bytes)?;
                self.record(path, &crate::digest::hash_bytes(&bytes));
            }
            ConflictResolution::KeepBoth => {
                let bytes = provider.fetch(path)?;
                let local_bytes = fs::read(&local_path).map_err(|e| format!("Cannot read {path}: {e}"))?;
                drop(provider);
                let name = local_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string());
                let copy = unique_path(&local_path.with_file_name(resolve_name(&name, &self.device)));
                write_atomic(&copy, &bytes)?;
                // The local copy wins the original name, and the incoming one
                // is uploaded under its new name so the other device sees it too.
                let copy_relative = relative_to(&self.root, &copy);
                let provider = self.provider.lock().unwrap();
                provider.upload(&copy_relative, &bytes)?;
                let digest = provider.upload(path, &local_bytes)?;
                drop(provider);
                self.record(path, &digest.hash);
                self.record(&copy_relative, &crate::digest::hash_bytes(&bytes));
            }
        }
        Ok(self.sync_once())
    }

    fn perform(&self, path: &str, action: SyncAction) -> Result<(), String> {
        let local_path = self.absolute(path)?;
        match action {
            SyncAction::Push | SyncAction::PushNew => {
                let bytes = fs::read(&local_path).map_err(|e| format!("Cannot read {path}: {e}"))?;
                let digest = self.provider.lock().unwrap().upload(path, &bytes)?;
                self.record(path, &digest.hash);
            }
            SyncAction::Pull | SyncAction::PullNew => {
                let bytes = self.provider.lock().unwrap().fetch(path)?;
                write_atomic(&local_path, &bytes)?;
                self.record(path, &crate::digest::hash_bytes(&bytes));
            }
            SyncAction::DeleteLocal => {
                fs::remove_file(&local_path).ok();
                self.state.lock().unwrap().records.remove(path);
            }
            SyncAction::DeleteRemote => {
                self.provider.lock().unwrap().remove(path)?;
                self.state.lock().unwrap().records.remove(path);
            }
            _ => {}
        }
        Ok(())
    }

    /// Both sides already hold the same content: agree on it as the new base.
    fn rebase(&self, path: &str) -> Result<(), String> {
        let local_path = self.absolute(path)?;
        let digest = FileDigest::of_file(&local_path).map_err(|e| format!("Cannot read {path}: {e}"))?;
        self.record(path, &digest.hash);
        Ok(())
    }

    fn record(&self, path: &str, hash: &str) {
        self.state.lock().unwrap().records.insert(
            path.to_string(),
            SyncRecord {
                path: path.to_string(),
                base_hash: hash.to_string(),
                synced_at_ms: now_ms(),
            },
        );
    }

    pub fn state(&self) -> SyncState {
        self.state.lock().unwrap().clone()
    }

    pub fn restore_state(&self, state: SyncState) {
        *self.state.lock().unwrap() = state;
    }

    fn absolute(&self, relative: &str) -> Result<PathBuf, String> {
        let path = relative
            .split('/')
            .fold(self.root.clone(), |mut acc, part| {
                acc.push(part);
                acc
            });
        if !crate::library::within_root(&self.root, &path) {
            return Err(format!("{relative} is outside the library"));
        }
        Ok(path)
    }

    fn set_phase(&self, phase: SyncPhase) {
        self.status.lock().unwrap().phase = phase;
    }

    fn fail(&self, message: String) -> SyncStatus {
        let mut status = self.status.lock().unwrap();
        status.phase = SyncPhase::Error;
        status.message = Some(message);
        status.clone()
    }
}

/// Is this event about a document, rather than a temp file or a directory scan?
fn touches_documents(event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|path| {
        let is_notex = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case(NOTEX_EXTENSION))
            .unwrap_or(false);
        let hidden = path
            .file_name()
            .map(|n| n.to_string_lossy().starts_with('.'))
            .unwrap_or(false);
        // The sibling temp file of an atomic write is `.name.pid.tmp`: it is a
        // `.tmp`, it is hidden, and reacting to it would mean syncing a
        // half-written document.
        is_notex && !hidden
    })
}

fn collect(root: &Path, dir: &Path, out: &mut HashMap<String, FileDigest>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let hidden = path.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false);
        if hidden {
            continue;
        }
        if path.is_dir() {
            collect(root, &path, out);
        } else if path.extension().map(|e| e.eq_ignore_ascii_case(NOTEX_EXTENSION)).unwrap_or(false) {
            if let Ok(digest) = FileDigest::of_file(&path) {
                out.insert(relative_to(root, &path), digest);
            }
        }
    }
}

/// Temp file plus rename, so a sync that is interrupted never leaves a
/// half-written document where a whole one used to be.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "document".into());
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot replace {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::test_support::MemoryProvider;
    use std::{sync::mpsc::RecvTimeoutError, time::Instant};

    /// A manager over a temp library, holding on to the provider for assertions.
    fn manager(root: &Path) -> (SyncManager, Arc<MemoryProvider>) {
        let provider = Arc::new(MemoryProvider::connected());
        let manager = SyncManager::new(root.to_path_buf(), "Surface");
        manager.set_provider(Box::new(SharedProvider(Arc::clone(&provider))));
        (manager, provider)
    }

    /// Lets a test keep a handle on the provider the manager owns.
    struct SharedProvider(Arc<MemoryProvider>);

    impl CloudProvider for SharedProvider {
        fn name(&self) -> &str {
            self.0.name()
        }
        fn is_connected(&self) -> bool {
            self.0.is_connected()
        }
        fn list(&self) -> Result<Vec<crate::provider::RemoteFile>, String> {
            self.0.list()
        }
        fn fetch(&self, path: &str) -> Result<Vec<u8>, String> {
            self.0.fetch(path)
        }
        fn upload(&self, path: &str, bytes: &[u8]) -> Result<FileDigest, String> {
            self.0.upload(path, bytes)
        }
        fn remove(&self, path: &str) -> Result<(), String> {
            self.0.remove(path)
        }
    }

    fn action_for(plan: &[(String, SyncAction)], path: &str) -> Option<SyncAction> {
        plan.iter().find(|(p, _)| p == path).map(|(_, a)| a.clone())
    }

    // ---- the watcher ------------------------------------------------------

    #[test]
    fn the_watcher_reports_a_saved_document() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = manager(root.path());
        let events = manager.watch().unwrap();
        assert!(!manager.is_dirty());

        fs::write(root.path().join("Week 1.notex"), b"{}").unwrap();
        events.recv_timeout(Duration::from_secs(10)).expect("no event for a saved document");
        assert!(manager.is_dirty());
        manager.stop_watching();
    }

    #[test]
    fn the_watcher_sees_documents_inside_folders() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = manager(root.path());
        let folder = root.path().join("Maths");
        fs::create_dir(&folder).unwrap();
        let events = manager.watch().unwrap();

        fs::write(folder.join("Algebra.notex"), b"{}").unwrap();
        events.recv_timeout(Duration::from_secs(10)).expect("no event for a filed document");
        manager.stop_watching();
    }

    #[test]
    fn a_pass_reconciles_what_the_watcher_may_have_missed() {
        // A file written into a directory created moments earlier can beat the
        // recursive watch to it on every platform, and inotify drops events
        // when its queue overflows. The watcher is an optimisation; the pass
        // is the guarantee, so it must find the file whether or not an event
        // ever arrived.
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let _events = manager.watch().unwrap();

        let folder = root.path().join("Maths");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("Algebra.notex"), b"missed by the watcher").unwrap();

        assert_eq!(manager.sync_once().phase, SyncPhase::UpToDate);
        assert_eq!(provider.get("Maths/Algebra.notex").unwrap(), b"missed by the watcher");
        manager.stop_watching();
    }

    #[test]
    fn the_watcher_ignores_everything_that_is_not_a_document() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = manager(root.path());
        let events = manager.watch().unwrap();

        // A half-written save, a scratch file and an unrelated one. None of
        // these is a document, and reacting to the first would mean uploading
        // a truncated file.
        fs::write(root.path().join(".Week 1.notex.99.tmp"), b"half a document").unwrap();
        fs::write(root.path().join("notes.txt"), b"unrelated").unwrap();
        fs::create_dir(root.path().join("Empty folder")).unwrap();

        assert!(matches!(
            events.recv_timeout(Duration::from_millis(1_200)),
            Err(RecvTimeoutError::Timeout)
        ));
        assert!(!manager.is_dirty());
        manager.stop_watching();
    }

    #[test]
    fn a_burst_of_writes_settles_into_one_pass() {
        // An atomic save is create, write, flush, rename, and the autosave
        // repeats while the pen is moving. One pass, not four.
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = manager(root.path());
        let events = manager.watch().unwrap();
        let path = root.path().join("Week 1.notex");

        let started = Instant::now();
        for i in 0..8 {
            fs::write(&path, format!("{{\"n\":{i}}}").as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(40));
        }
        events.recv_timeout(Duration::from_secs(10)).expect("no event for a burst of saves");
        // The pass waits for quiet rather than firing on the first write.
        assert!(started.elapsed() >= SETTLE);
        assert!(matches!(
            events.recv_timeout(Duration::from_millis(1_200)),
            Err(RecvTimeoutError::Timeout)
        ));
        manager.stop_watching();
    }

    // ---- planning and passes ---------------------------------------------

    #[test]
    fn scanning_finds_documents_at_every_depth_and_skips_the_rest() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = manager(root.path());
        fs::write(root.path().join("Week 1.notex"), b"one").unwrap();
        fs::create_dir(root.path().join("Maths")).unwrap();
        fs::write(root.path().join("Maths/Algebra.notex"), b"two").unwrap();
        fs::write(root.path().join("Maths/notes.txt"), b"not a document").unwrap();
        fs::write(root.path().join(".hidden.notex"), b"not a document either").unwrap();

        let local = manager.scan_local();
        let mut paths: Vec<&String> = local.keys().collect();
        paths.sort();
        assert_eq!(paths, ["Maths/Algebra.notex", "Week 1.notex"]);
    }

    #[test]
    fn a_new_local_document_is_uploaded() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        fs::write(root.path().join("Week 1.notex"), b"first draft").unwrap();

        assert_eq!(action_for(&manager.plan().unwrap(), "Week 1.notex"), Some(SyncAction::PushNew));
        let status = manager.sync_once();
        assert_eq!(status.phase, SyncPhase::UpToDate);
        assert_eq!(provider.get("Week 1.notex").unwrap(), b"first draft");
        // And a second pass has nothing left to do.
        assert_eq!(action_for(&manager.plan().unwrap(), "Week 1.notex"), Some(SyncAction::InSync));
    }

    #[test]
    fn a_new_remote_document_is_downloaded() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        provider.put("Maths/Algebra.notex", b"from the tablet");

        manager.sync_once();
        assert_eq!(fs::read(root.path().join("Maths/Algebra.notex")).unwrap(), b"from the tablet");
        assert_eq!(action_for(&manager.plan().unwrap(), "Maths/Algebra.notex"), Some(SyncAction::InSync));
    }

    #[test]
    fn an_edit_on_one_side_travels_to_the_other() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();

        fs::write(&path, b"v2").unwrap();
        assert_eq!(action_for(&manager.plan().unwrap(), "Week 1.notex"), Some(SyncAction::Push));
        manager.sync_once();
        assert_eq!(provider.get("Week 1.notex").unwrap(), b"v2");

        provider.put("Week 1.notex", b"v3");
        assert_eq!(action_for(&manager.plan().unwrap(), "Week 1.notex"), Some(SyncAction::Pull));
        manager.sync_once();
        assert_eq!(fs::read(&path).unwrap(), b"v3");
    }

    #[test]
    fn nothing_is_touched_while_a_conflict_is_unanswered() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();

        fs::write(&path, b"written on the laptop").unwrap();
        provider.put("Week 1.notex", b"written on the tablet");

        let status = manager.sync_once();
        assert_eq!(status.phase, SyncPhase::Conflicted);
        assert_eq!(status.conflicts, ["Week 1.notex"]);
        // Both copies are exactly as they were: an engine that guessed here
        // would have thrown one of them away.
        assert_eq!(fs::read(&path).unwrap(), b"written on the laptop");
        assert_eq!(provider.get("Week 1.notex").unwrap(), b"written on the tablet");
    }

    #[test]
    fn keeping_local_pushes_it_and_clears_the_conflict() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();
        fs::write(&path, b"laptop").unwrap();
        provider.put("Week 1.notex", b"tablet");
        manager.sync_once();

        let status = manager.resolve("Week 1.notex", ConflictResolution::KeepLocal).unwrap();
        assert_eq!(status.phase, SyncPhase::UpToDate);
        assert!(status.conflicts.is_empty());
        assert_eq!(provider.get("Week 1.notex").unwrap(), b"laptop");
        assert_eq!(fs::read(&path).unwrap(), b"laptop");
    }

    #[test]
    fn keeping_remote_overwrites_the_local_copy() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();
        fs::write(&path, b"laptop").unwrap();
        provider.put("Week 1.notex", b"tablet");
        manager.sync_once();

        let status = manager.resolve("Week 1.notex", ConflictResolution::KeepRemote).unwrap();
        assert_eq!(status.phase, SyncPhase::UpToDate);
        assert_eq!(fs::read(&path).unwrap(), b"tablet");
    }

    #[test]
    fn keeping_both_loses_nothing_and_both_devices_end_up_with_both() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();
        fs::write(&path, b"laptop").unwrap();
        provider.put("Week 1.notex", b"tablet");
        manager.sync_once();

        let status = manager.resolve("Week 1.notex", ConflictResolution::KeepBoth).unwrap();
        assert_eq!(status.phase, SyncPhase::UpToDate);
        assert!(status.conflicts.is_empty());

        // The original name keeps the local work…
        assert_eq!(fs::read(&path).unwrap(), b"laptop");
        assert_eq!(provider.get("Week 1.notex").unwrap(), b"laptop");
        // …and the incoming copy lands beside it, on both sides, under a name
        // that says where it came from.
        let copy = root.path().join("Week 1 (conflicted copy from Surface).notex");
        assert_eq!(fs::read(&copy).unwrap(), b"tablet");
        assert_eq!(
            provider.get("Week 1 (conflicted copy from Surface).notex").unwrap(),
            b"tablet"
        );
        assert_eq!(provider.len(), 2);
    }

    #[test]
    fn a_second_conflict_on_the_same_file_does_not_overwrite_the_first_copy() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();

        for incoming in [b"tablet one", b"tablet two"] {
            fs::write(&path, b"laptop").unwrap();
            provider.put("Week 1.notex", incoming);
            manager.sync_once();
            manager.resolve("Week 1.notex", ConflictResolution::KeepBoth).unwrap();
        }
        assert_eq!(
            fs::read(root.path().join("Week 1 (conflicted copy from Surface).notex")).unwrap(),
            b"tablet one"
        );
        assert_eq!(
            fs::read(root.path().join("Week 1 (conflicted copy from Surface) (2).notex")).unwrap(),
            b"tablet two"
        );
    }

    #[test]
    fn two_devices_making_the_same_edit_is_not_a_conflict() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();

        fs::write(&path, b"v2").unwrap();
        provider.put("Week 1.notex", b"v2");
        let status = manager.sync_once();
        assert_eq!(status.phase, SyncPhase::UpToDate);
        // And the base moved on, so the next edit is judged against v2.
        fs::write(&path, b"v3").unwrap();
        assert_eq!(action_for(&manager.plan().unwrap(), "Week 1.notex"), Some(SyncAction::Push));
    }

    #[test]
    fn a_deletion_propagates_but_never_over_an_edit() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        let path = root.path().join("Week 1.notex");
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();

        provider.remove("Week 1.notex").unwrap();
        manager.sync_once();
        assert!(!path.exists());

        // Now the other way, with an edit in the way of the deletion.
        fs::write(&path, b"v1").unwrap();
        manager.sync_once();
        provider.put("Week 1.notex", b"edited elsewhere");
        fs::remove_file(&path).unwrap();
        let status = manager.sync_once();
        assert_eq!(status.phase, SyncPhase::Conflicted);
        assert_eq!(provider.get("Week 1.notex").unwrap(), b"edited elsewhere");
    }

    #[test]
    fn an_offline_provider_reports_offline_and_moves_nothing() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        fs::write(root.path().join("Week 1.notex"), b"v1").unwrap();
        provider.set_connected(false);

        let status = manager.sync_once();
        assert_eq!(status.phase, SyncPhase::Offline);
        assert_eq!(provider.len(), 0);

        provider.set_connected(true);
        assert_eq!(manager.sync_once().phase, SyncPhase::UpToDate);
        assert_eq!(provider.len(), 1);
    }

    #[test]
    fn the_base_records_survive_a_restart() {
        let root = tempfile::tempdir().unwrap();
        let (manager, provider) = manager(root.path());
        fs::write(root.path().join("Week 1.notex"), b"v1").unwrap();
        manager.sync_once();
        let saved = manager.state();

        // A fresh manager with the records restored knows the file is settled;
        // without them it would see an unsynced file on both sides and, because
        // the contents match, converge rather than guess.
        let restarted = SyncManager::new(root.path().to_path_buf(), "Surface");
        restarted.set_provider(Box::new(SharedProvider(Arc::clone(&provider))));
        restarted.restore_state(saved);
        assert_eq!(action_for(&restarted.plan().unwrap(), "Week 1.notex"), Some(SyncAction::InSync));
    }

    #[test]
    fn a_path_from_the_frontend_cannot_escape_the_library() {
        let root = tempfile::tempdir().unwrap();
        let (manager, _) = manager(root.path());
        assert!(manager.absolute("../../etc/passwd").is_err());
        assert!(manager.absolute("Maths/Algebra.notex").is_ok());
    }
}
