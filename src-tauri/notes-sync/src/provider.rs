//! The seam a real cloud backend plugs into.
//!
//! Nothing here talks to a network. The point of the trait is that the sync
//! engine above it — the watcher, the three-way decision, the conflict
//! protocol — is written once against an interface that WebDAV (`PROPFIND`,
//! `GET`, `PUT`, `DELETE`) and Google Drive (`files.list`, `files.get`,
//! `files.create`, `files.update`) can both satisfy, so adding one is a new
//! implementation rather than a rewrite.
//!
//! The interface is deliberately the intersection of the two: a flat listing
//! keyed by relative path, whole-file get and put, and delete. Drive's file
//! ids and WebDAV's collections are each providers' own problem; the engine
//! only ever names a file by the path it has in the library.

use crate::digest::FileDigest;

/// One file as the remote sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    /// Path relative to the library root, using `/` on every platform.
    pub path: String,
    pub digest: FileDigest,
}

pub type ProviderResult<T> = Result<T, String>;

/// A remote store of `.notex` files.
///
/// Implementations must be `Send + Sync`: the manager holds one behind a lock
/// and drives it from a background thread.
pub trait CloudProvider: Send + Sync {
    /// Name shown in the UI ("WebDAV", "Google Drive", "Not connected").
    fn name(&self) -> &str;

    /// False when there is no account, no network, or the token has expired.
    /// The manager reports `Offline` rather than failing every operation.
    fn is_connected(&self) -> bool;

    /// Every file the remote holds, with its digest.
    ///
    /// Both target APIs can answer this in one round trip — WebDAV with a
    /// `PROPFIND` of depth infinity, Drive with a paged `files.list` — and
    /// both can carry the hash in a property, so a listing does not have to
    /// download anything to be useful.
    fn list(&self) -> ProviderResult<Vec<RemoteFile>>;

    /// Fetch one file's bytes.
    fn fetch(&self, path: &str) -> ProviderResult<Vec<u8>>;

    /// Upload one file, returning the digest the remote ended up with.
    fn upload(&self, path: &str, bytes: &[u8]) -> ProviderResult<FileDigest>;

    /// Remove one file.
    fn remove(&self, path: &str) -> ProviderResult<()>;
}

/// The provider used until an account is connected: everything is local, and
/// the manager reports `Offline` without ever pretending a sync happened.
#[derive(Debug, Default)]
pub struct OfflineProvider;

impl CloudProvider for OfflineProvider {
    fn name(&self) -> &str {
        "Not connected"
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn list(&self) -> ProviderResult<Vec<RemoteFile>> {
        Ok(Vec::new())
    }

    fn fetch(&self, path: &str) -> ProviderResult<Vec<u8>> {
        Err(format!("No cloud account is connected, so {path} cannot be fetched"))
    }

    fn upload(&self, path: &str, _bytes: &[u8]) -> ProviderResult<FileDigest> {
        Err(format!("No cloud account is connected, so {path} cannot be uploaded"))
    }

    fn remove(&self, path: &str) -> ProviderResult<()> {
        Err(format!("No cloud account is connected, so {path} cannot be removed"))
    }
}

#[cfg(test)]
pub mod test_support {
    //! An in-memory provider, so the engine above can be tested end to end
    //! without a network or a fixture server.
    use std::{
        collections::BTreeMap,
        sync::{Mutex, MutexGuard},
    };

    use super::*;
    use crate::digest::now_ms;

    #[derive(Debug, Default)]
    pub struct MemoryProvider {
        files: Mutex<BTreeMap<String, Vec<u8>>>,
        connected: Mutex<bool>,
    }

    impl MemoryProvider {
        pub fn connected() -> Self {
            Self {
                files: Mutex::new(BTreeMap::new()),
                connected: Mutex::new(true),
            }
        }

        pub fn set_connected(&self, value: bool) {
            *self.connected.lock().unwrap() = value;
        }

        pub fn put(&self, path: &str, bytes: &[u8]) {
            self.files().insert(path.to_string(), bytes.to_vec());
        }

        pub fn get(&self, path: &str) -> Option<Vec<u8>> {
            self.files().get(path).cloned()
        }

        pub fn len(&self) -> usize {
            self.files().len()
        }

        fn files(&self) -> MutexGuard<'_, BTreeMap<String, Vec<u8>>> {
            self.files.lock().unwrap()
        }
    }

    impl CloudProvider for MemoryProvider {
        fn name(&self) -> &str {
            "In-memory"
        }

        fn is_connected(&self) -> bool {
            *self.connected.lock().unwrap()
        }

        fn list(&self) -> ProviderResult<Vec<RemoteFile>> {
            Ok(self
                .files()
                .iter()
                .map(|(path, bytes)| RemoteFile {
                    path: path.clone(),
                    digest: FileDigest::of_bytes(bytes, now_ms()),
                })
                .collect())
        }

        fn fetch(&self, path: &str) -> ProviderResult<Vec<u8>> {
            self.files()
                .get(path)
                .cloned()
                .ok_or_else(|| format!("{path} is not on the remote"))
        }

        fn upload(&self, path: &str, bytes: &[u8]) -> ProviderResult<FileDigest> {
            self.files().insert(path.to_string(), bytes.to_vec());
            Ok(FileDigest::of_bytes(bytes, now_ms()))
        }

        fn remove(&self, path: &str) -> ProviderResult<()> {
            self.files().remove(path);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{test_support::MemoryProvider, *};

    #[test]
    fn the_offline_provider_refuses_rather_than_pretending() {
        let provider = OfflineProvider;
        assert!(!provider.is_connected());
        assert_eq!(provider.list().unwrap(), Vec::new());
        assert!(provider.fetch("a.notex").is_err());
        assert!(provider.upload("a.notex", b"{}").is_err());
    }

    #[test]
    fn a_provider_round_trips_bytes_and_reports_digests() {
        let provider = MemoryProvider::connected();
        let digest = provider.upload("Maths/week 1.notex", b"{\"format\":\"notex\"}").unwrap();
        assert_eq!(provider.fetch("Maths/week 1.notex").unwrap(), b"{\"format\":\"notex\"}");
        let listed = provider.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, "Maths/week 1.notex");
        assert_eq!(listed[0].digest.hash, digest.hash);
        provider.remove("Maths/week 1.notex").unwrap();
        assert!(provider.list().unwrap().is_empty());
    }
}
