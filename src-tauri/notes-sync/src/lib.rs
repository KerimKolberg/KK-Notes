//! Document library indexing and cross-device synchronisation.
//!
//! Split out of the Tauri shell on purpose. The shell cannot be compiled — let
//! alone tested — without a platform webview and its system libraries, and
//! none of the logic here needs one: listing a directory, extracting a
//! thumbnail, hashing a file and deciding what to do about a conflict are all
//! plain Rust. Keeping them in their own crate means `cargo test -p
//! notes-sync` runs on any machine, which is the difference between this
//! being tested and not.

pub mod account;
pub mod conflict;
pub mod digest;
pub mod drive;
pub mod http;
pub mod library;
pub mod loopback;
pub mod manager;
pub mod oauth;
pub mod provider;
pub mod thumb;

pub use account::DriveAccount;
pub use conflict::{ConflictResolution, SyncAction, SyncRecord, decide, resolve_name};
pub use drive::{GoogleDrive, TokenSource};
pub use digest::{FileDigest, hash_bytes, now_ms};
pub use http::{HttpRequest, HttpResponse, HttpTransport, Method, UnavailableTransport};
pub use library::{LibraryEntry, LibraryListing, SortKey, SortOrder, is_content_uri, list_directory, sort_entries};
pub use loopback::RedirectListener;
pub use manager::{SyncManager, SyncPhase, SyncStatus};
pub use oauth::{AuthSession, Pkce, RedirectTarget, TokenSet};
pub use provider::{CloudProvider, OfflineProvider, RemoteFile};
pub use thumb::{ThumbnailSource, read_thumbnail_source};
