//! Content fingerprints.
//!
//! Sync decisions are made on content, not on timestamps. A clock that runs
//! fast on one device, a file copied by a tool that preserves mtimes, a cloud
//! client that rewrites a file byte-for-byte — all of them produce timestamps
//! that say "changed" about a file that did not. Hashing the bytes is the only
//! answer that is the same on every device.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// SHA-256 of `bytes`, lowercase hex.
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// What is known about one file, locally or remotely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDigest {
    /// SHA-256 of the file's bytes, lowercase hex.
    pub hash: String,
    pub bytes: u64,
    /// Unix epoch milliseconds. Carried for display and tie-breaking only —
    /// never for deciding whether something changed.
    pub modified_ms: u64,
}

impl FileDigest {
    pub fn of_bytes(bytes: &[u8], modified_ms: u64) -> Self {
        Self {
            hash: hash_bytes(bytes),
            bytes: bytes.len() as u64,
            modified_ms,
        }
    }

    pub fn of_file(path: &Path) -> std::io::Result<Self> {
        let bytes = fs::read(path)?;
        let modified_ms = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(Self::of_bytes(&bytes, modified_ms))
    }

    /// Same content? Only the hash is consulted, for the reasons above.
    pub fn same_content(&self, other: &FileDigest) -> bool {
        self.hash == other.hash
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_stable_and_content_addressed() {
        // The empty input's SHA-256 is a well-known constant; if this changes
        // the algorithm changed, and every stored sync record is invalid.
        assert_eq!(
            hash_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(hash_bytes(b"notex"), hash_bytes(b"notex"));
        assert_ne!(hash_bytes(b"notex"), hash_bytes(b"noteX"));
    }

    #[test]
    fn identical_content_matches_despite_different_timestamps() {
        let a = FileDigest::of_bytes(b"{\"format\":\"notex\"}", 1_000);
        let b = FileDigest::of_bytes(b"{\"format\":\"notex\"}", 9_999_999);
        assert!(a.same_content(&b));
        assert_eq!(a.bytes, 18);
    }

    #[test]
    fn a_single_changed_byte_is_a_different_file() {
        let a = FileDigest::of_bytes(b"page one", 0);
        let b = FileDigest::of_bytes(b"page two", 0);
        assert!(!a.same_content(&b));
    }
}
