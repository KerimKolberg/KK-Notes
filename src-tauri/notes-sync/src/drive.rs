//! Google Drive as a [`CloudProvider`].
//!
//! The sync engine names a file by the path it has in the library; Drive names
//! it by an opaque id and arranges it under parent folders. Reconciling those
//! two is most of what this file does, and the choice that makes it cheap is
//! **carrying the library path and the content hash in the file's
//! `appProperties`**:
//!
//! - `list()` is then a *single* paged query — "every file this app created" —
//!   no matter how deeply the library nests, because the path travels with the
//!   file rather than having to be rebuilt by walking parents. One round trip
//!   instead of one per folder.
//! - The digest comes back with the listing, so deciding what changed costs no
//!   downloads at all. That is what [`crate::conflict::decide`] needs to make
//!   a three-way decision, and downloading every file to hash it would make
//!   sync unusable on a phone.
//! - A file the user drags somewhere else in Drive is still *this* file, since
//!   its identity never depended on where it sits.
//!
//! Folders are still mirrored for real, under one "Notex Sync" folder, because
//! someone who opens Drive should see their notebooks arranged the way they
//! arranged them — the properties are how the app finds things, not a
//! substitute for doing that properly.
//!
//! Nothing here opens a socket: every request goes through an
//! [`HttpTransport`], which is what lets the whole of it be tested against
//! recorded Drive responses.

use std::{
    collections::HashMap,
    sync::{Mutex, RwLock},
};

use crate::{
    digest::FileDigest,
    http::{query_url, HttpRequest, HttpResponse, HttpTransport},
    provider::{CloudProvider, ProviderResult, RemoteFile},
};

/// The one folder this app creates at the root of a user's Drive.
pub const SYNC_FOLDER_NAME: &str = "Notex Sync";
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const NOTEX_MIME: &str = "application/vnd.notex+json";

/// Marks a file as ours, so one query finds all of them.
pub const APP_MARKER_KEY: &str = "notexApp";
pub const APP_MARKER_VALUE: &str = "1";
/// The file's path within the library, `/`-separated.
pub const PATH_KEY: &str = "notexPath";
/// The SHA-256 of the bytes as uploaded.
pub const DIGEST_KEY: &str = "notexSha256";

const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// Drive caps `pageSize` at 1000.
const PAGE_SIZE: &str = "1000";
/// The boundary for multipart uploads. Fixed rather than random because the
/// parts are JSON and a `.notex` file, and a chosen-plaintext attack on a
/// multipart boundary is not a threat model that applies to a body we build
/// ourselves and send over TLS to one host.
const BOUNDARY: &str = "notex-drive-boundary-3f8c1a";

/// Where the access token comes from, and how to say one went stale.
///
/// Refreshing needs the client id, the refresh token and somewhere to persist
/// the result — all of which live in the Tauri shell — so the provider asks
/// for a token rather than owning the credentials.
pub trait TokenSource: Send + Sync {
    /// A usable access token, refreshing first if it is due.
    fn access_token(&self) -> Result<String, String>;

    /// Called when Drive rejects a token that was believed good, so the next
    /// call refreshes instead of reusing it.
    fn invalidate(&self);

    /// False when no account is connected. Never performs a network call:
    /// the status indicator asks this on every pass.
    fn is_connected(&self) -> bool;

    /// The signed-in account, for the provider's display name.
    fn account(&self) -> Option<String>;
}

/// So the shell can keep the account it signs in with and still hand the same
/// one to the provider, rather than the two drifting apart.
impl<K: TokenSource> TokenSource for std::sync::Arc<K> {
    fn access_token(&self) -> Result<String, String> {
        (**self).access_token()
    }
    fn invalidate(&self) {
        (**self).invalidate();
    }
    fn is_connected(&self) -> bool {
        (**self).is_connected()
    }
    fn account(&self) -> Option<String> {
        (**self).account()
    }
}

pub struct GoogleDrive<T: HttpTransport, K: TokenSource> {
    transport: T,
    tokens: K,
    /// The id of "Notex Sync", once it has been found or created.
    root_folder: Mutex<Option<String>>,
    /// Library path to Drive file id, learned from every listing. Needed
    /// because `upload` and `fetch` are given a path and Drive wants an id.
    ids: RwLock<HashMap<String, String>>,
    /// Library folder path to Drive folder id, so a nested upload does not
    /// re-resolve every ancestor each time.
    folders: RwLock<HashMap<String, String>>,
    name: String,
}

impl<T: HttpTransport, K: TokenSource> GoogleDrive<T, K> {
    pub fn new(transport: T, tokens: K) -> Self {
        let name = match tokens.account() {
            Some(account) if !account.is_empty() => format!("Google Drive ({account})"),
            _ => "Google Drive".to_string(),
        };
        Self {
            transport,
            tokens,
            root_folder: Mutex::new(None),
            ids: RwLock::new(HashMap::new()),
            folders: RwLock::new(HashMap::new()),
            name,
        }
    }

    /// Send with the bearer token, refreshing and retrying once on a 401.
    ///
    /// The retry is not paranoia: an access token can expire between being
    /// fetched and being read, and a token can be revoked from Google's
    /// account page at any moment. One retry distinguishes "this needs a new
    /// token" from "this account is gone", and the second 401 is reported
    /// honestly rather than looping.
    fn send(&self, build: impl Fn(&str) -> HttpRequest) -> ProviderResult<HttpResponse> {
        let token = self.tokens.access_token()?;
        let response = self.transport.send(build(&token))?;
        if !response.is_unauthorized() {
            return Ok(response);
        }
        self.tokens.invalidate();
        let token = self.tokens.access_token()?;
        Ok(self.transport.send(build(&token))?)
    }

    /// Send, and turn anything that is not a 2xx into a readable error.
    fn send_ok(&self, build: impl Fn(&str) -> HttpRequest) -> ProviderResult<HttpResponse> {
        let response = self.send(build)?;
        if response.is_success() {
            return Ok(response);
        }
        Err(drive_error(&response))
    }

    /// The id of "Notex Sync", creating it the first time.
    pub fn root_folder_id(&self) -> ProviderResult<String> {
        if let Some(id) = self.root_folder.lock().unwrap().clone() {
            return Ok(id);
        }
        let id = match self.find_folder(SYNC_FOLDER_NAME, "root")? {
            Some(id) => id,
            None => self.create_folder(SYNC_FOLDER_NAME, "root")?,
        };
        *self.root_folder.lock().unwrap() = Some(id.clone());
        Ok(id)
    }

    fn find_folder(&self, name: &str, parent: &str) -> ProviderResult<Option<String>> {
        let query = format!(
            "name = '{}' and mimeType = '{FOLDER_MIME}' and '{}' in parents and trashed = false",
            escape_query(name),
            escape_query(parent)
        );
        let url = query_url(
            FILES_ENDPOINT,
            &[("q", &query), ("fields", "files(id,name)"), ("pageSize", "10"), ("spaces", "drive")],
        );
        let response = self.send_ok(|token| HttpRequest::get(&url).bearer(token))?;
        let value = response.json()?;
        Ok(value
            .get("files")
            .and_then(|f| f.as_array())
            .and_then(|files| files.first())
            .and_then(|file| file.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_string))
    }

    fn create_folder(&self, name: &str, parent: &str) -> ProviderResult<String> {
        let metadata = serde_json::json!({
            "name": name,
            "mimeType": FOLDER_MIME,
            "parents": [parent],
            "appProperties": { APP_MARKER_KEY: APP_MARKER_VALUE },
        })
        .to_string();
        let url = query_url(FILES_ENDPOINT, &[("fields", "id")]);
        let response = self.send_ok(|token| {
            HttpRequest::post(&url)
                .bearer(token)
                .body("application/json; charset=UTF-8", metadata.clone().into_bytes())
        })?;
        response
            .json()?
            .get("id")
            .and_then(|id| id.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("Drive created \"{name}\" but did not say what its id is"))
    }

    /// The Drive folder that should hold `path`, creating any missing part of
    /// the chain. `"Maths/week 1.notex"` resolves `Maths` under "Notex Sync".
    fn parent_for(&self, path: &str) -> ProviderResult<String> {
        let mut parent = self.root_folder_id()?;
        let mut walked = String::new();
        let segments: Vec<&str> = path.split('/').collect();
        for segment in segments.iter().take(segments.len().saturating_sub(1)) {
            if segment.is_empty() {
                continue;
            }
            if !walked.is_empty() {
                walked.push('/');
            }
            walked.push_str(segment);
            if let Some(id) = self.folders.read().unwrap().get(&walked).cloned() {
                parent = id;
                continue;
            }
            let id = match self.find_folder(segment, &parent)? {
                Some(id) => id,
                None => self.create_folder(segment, &parent)?,
            };
            self.folders.write().unwrap().insert(walked.clone(), id.clone());
            parent = id;
        }
        Ok(parent)
    }

    fn known_id(&self, path: &str) -> Option<String> {
        self.ids.read().unwrap().get(path).cloned()
    }

    /// Find a file's id when the cache does not have it — after a restart, or
    /// for a file another device uploaded since the last listing.
    fn lookup_id(&self, path: &str) -> ProviderResult<Option<String>> {
        if let Some(id) = self.known_id(path) {
            return Ok(Some(id));
        }
        let query = format!(
            "appProperties has {{ key = '{PATH_KEY}' and value = '{}' }} and trashed = false",
            escape_query(path)
        );
        let url = query_url(
            FILES_ENDPOINT,
            &[("q", &query), ("fields", "files(id)"), ("pageSize", "10"), ("spaces", "drive")],
        );
        let response = self.send_ok(|token| HttpRequest::get(&url).bearer(token))?;
        let id = response
            .json()?
            .get("files")
            .and_then(|f| f.as_array())
            .and_then(|files| files.first())
            .and_then(|file| file.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_string);
        if let Some(id) = &id {
            self.ids.write().unwrap().insert(path.to_string(), id.clone());
        }
        Ok(id)
    }

    fn require_id(&self, path: &str) -> ProviderResult<String> {
        self.lookup_id(path)?
            .ok_or_else(|| format!("{path} is not in Google Drive"))
    }

    /// `multipart/related`: the metadata as JSON, then the file's bytes.
    ///
    /// Built by hand because it is four lines of framing and the alternative
    /// is a multipart crate in a build that has to cross-compile to four
    /// Android ABIs. The parts are ours, so there is nothing to negotiate.
    fn multipart(metadata: &str, bytes: &[u8]) -> Vec<u8> {
        let mut body = Vec::with_capacity(bytes.len() + metadata.len() + 256);
        body.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes());
        body.extend_from_slice(metadata.as_bytes());
        body.extend_from_slice(format!("\r\n--{BOUNDARY}\r\nContent-Type: {NOTEX_MIME}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
        body
    }
}

impl<T: HttpTransport, K: TokenSource> CloudProvider for GoogleDrive<T, K> {
    fn name(&self) -> &str {
        &self.name
    }

    fn is_connected(&self) -> bool {
        self.tokens.is_connected()
    }

    fn list(&self) -> ProviderResult<Vec<RemoteFile>> {
        let query = format!(
            "appProperties has {{ key = '{APP_MARKER_KEY}' and value = '{APP_MARKER_VALUE}' }} \
             and mimeType != '{FOLDER_MIME}' and trashed = false"
        );
        let fields = "nextPageToken,files(id,name,size,modifiedTime,appProperties)";

        let mut out = Vec::new();
        let mut ids = HashMap::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut params: Vec<(&str, &str)> = vec![
                ("q", &query),
                ("fields", fields),
                ("pageSize", PAGE_SIZE),
                ("spaces", "drive"),
            ];
            if let Some(token) = &page_token {
                params.push(("pageToken", token));
            }
            let url = query_url(FILES_ENDPOINT, &params);
            let response = self.send_ok(|token| HttpRequest::get(&url).bearer(token))?;
            let value = response.json()?;

            for file in value.get("files").and_then(|f| f.as_array()).unwrap_or(&Vec::new()) {
                let Some(id) = file.get("id").and_then(|v| v.as_str()) else { continue };
                let properties = file.get("appProperties");
                let path = properties
                    .and_then(|p| p.get(PATH_KEY))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let hash = properties.and_then(|p| p.get(DIGEST_KEY)).and_then(|v| v.as_str());

                // A file with our marker but no path or hash was written by a
                // version that did not record them, or edited by hand in
                // Drive. Skipping it is right: the engine compares hashes, and
                // inventing one would be a guess about someone's notes.
                let (Some(path), Some(hash)) = (path, hash) else { continue };

                ids.insert(path.clone(), id.to_string());
                out.push(RemoteFile {
                    path,
                    digest: FileDigest {
                        hash: hash.to_string(),
                        // Drive sends `size` as a string, since it can exceed
                        // what JSON numbers hold exactly.
                        bytes: file
                            .get("size")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u64>().ok())
                            .or_else(|| file.get("size").and_then(|v| v.as_u64()))
                            .unwrap_or(0),
                        modified_ms: file
                            .get("modifiedTime")
                            .and_then(|v| v.as_str())
                            .and_then(parse_rfc3339_ms)
                            .unwrap_or(0),
                    },
                });
            }

            page_token = value.get("nextPageToken").and_then(|t| t.as_str()).map(str::to_string);
            if page_token.is_none() {
                break;
            }
        }

        *self.ids.write().unwrap() = ids;
        Ok(out)
    }

    fn fetch(&self, path: &str) -> ProviderResult<Vec<u8>> {
        let id = self.require_id(path)?;
        let url = query_url(&format!("{FILES_ENDPOINT}/{id}"), &[("alt", "media")]);
        let response = self.send_ok(|token| HttpRequest::get(&url).bearer(token))?;
        Ok(response.body)
    }

    fn upload(&self, path: &str, bytes: &[u8]) -> ProviderResult<FileDigest> {
        let digest = FileDigest::of_bytes(bytes, crate::digest::now_ms());
        let name = path.rsplit('/').next().unwrap_or(path);
        let existing = self.lookup_id(path)?;

        // `parents` may only be set at creation: sending it on an update is a
        // 400 from Drive, and moving a file is a different call entirely.
        let metadata = match &existing {
            Some(_) => serde_json::json!({
                "name": name,
                "appProperties": {
                    APP_MARKER_KEY: APP_MARKER_VALUE,
                    PATH_KEY: path,
                    DIGEST_KEY: digest.hash,
                },
            }),
            None => {
                let parent = self.parent_for(path)?;
                serde_json::json!({
                    "name": name,
                    "parents": [parent],
                    "appProperties": {
                        APP_MARKER_KEY: APP_MARKER_VALUE,
                        PATH_KEY: path,
                        DIGEST_KEY: digest.hash,
                    },
                })
            }
        }
        .to_string();

        let body = Self::multipart(&metadata, bytes);
        let content_type = format!("multipart/related; boundary={BOUNDARY}");
        let response = match &existing {
            Some(id) => {
                let url = query_url(
                    &format!("{UPLOAD_ENDPOINT}/{id}"),
                    &[("uploadType", "multipart"), ("fields", "id,modifiedTime")],
                );
                self.send_ok(|token| {
                    HttpRequest::patch(&url)
                        .bearer(token)
                        .body(&content_type, body.clone())
                })?
            }
            None => {
                let url = query_url(UPLOAD_ENDPOINT, &[("uploadType", "multipart"), ("fields", "id,modifiedTime")]);
                self.send_ok(|token| {
                    HttpRequest::post(&url)
                        .bearer(token)
                        .body(&content_type, body.clone())
                })?
            }
        };

        let value = response.json()?;
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            self.ids.write().unwrap().insert(path.to_string(), id.to_string());
        }
        let modified_ms = value
            .get("modifiedTime")
            .and_then(|v| v.as_str())
            .and_then(parse_rfc3339_ms)
            .unwrap_or(digest.modified_ms);
        Ok(FileDigest { modified_ms, ..digest })
    }

    fn remove(&self, path: &str) -> ProviderResult<()> {
        // Already gone is the outcome that was asked for.
        let Some(id) = self.lookup_id(path)? else { return Ok(()) };
        // Trashed, not erased. A sync engine deleting someone's only copy
        // beyond recovery is the failure nobody forgives, and Drive's bin is
        // exactly the undo this needs.
        let url = query_url(&format!("{FILES_ENDPOINT}/{id}"), &[("fields", "id")]);
        let metadata = serde_json::json!({ "trashed": true }).to_string();
        self.send_ok(|token| {
            HttpRequest::patch(&url)
                .bearer(token)
                .body("application/json; charset=UTF-8", metadata.clone().into_bytes())
        })?;
        self.ids.write().unwrap().remove(path);
        Ok(())
    }
}

/// Drive's `q` is a little language with single-quoted literals, so a name
/// containing one has to escape it — otherwise "Tom's notes" ends the literal
/// early and the query is not merely wrong but a different query.
pub fn escape_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Turn a Drive error envelope into something worth showing a person.
pub fn drive_error(response: &HttpResponse) -> String {
    let detail = response
        .json()
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                        // The token endpoint uses a flat `error` string instead.
                        .or_else(|| error.as_str().map(str::to_string))
                })
                .or_else(|| value.get("error_description").and_then(|m| m.as_str()).map(str::to_string))
        })
        .unwrap_or_else(|| response.text().chars().take(200).collect());

    match response.status {
        401 => format!("Google Drive rejected the sign-in — connect the account again. ({detail})"),
        403 if detail.contains("storageQuota") || detail.to_lowercase().contains("quota") => {
            format!("Google Drive is out of space: {detail}")
        }
        403 => format!("Google Drive refused that: {detail}"),
        404 => format!("Google Drive no longer has that file: {detail}"),
        429 | 500..=599 => format!("Google Drive is unavailable right now: {detail}"),
        status => format!("Google Drive returned {status}: {detail}"),
    }
}

/// Parse the RFC 3339 timestamps Drive sends (`2026-09-18T12:34:56.789Z`).
///
/// Narrow on purpose: Drive always sends UTC with a `Z`, so this handles that
/// shape and returns `None` for anything else rather than pulling in a date
/// library. The value is only ever displayed or used as a tie-break — never to
/// decide whether a file changed — so a `None` costs nothing but a nicety.
pub fn parse_rfc3339_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || !text.ends_with('Z') {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let millis: i64 = match text.get(19..text.len() - 1) {
        Some(fraction) if fraction.starts_with('.') => {
            let digits: String = fraction[1..].chars().take(3).collect();
            format!("{digits:0<3}").parse().unwrap_or(0)
        }
        _ => 0,
    };

    // Howard Hinnant's days-from-civil: exact for every proleptic Gregorian
    // date, leap years and centuries included, in integer arithmetic.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(seconds * 1_000 + millis).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{test_support::MockTransport, Method};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A token source with no network behind it, which also counts refreshes
    /// so the 401 path can be asserted rather than assumed.
    struct FakeTokens {
        invalidations: AtomicUsize,
        connected: bool,
    }

    impl FakeTokens {
        fn new() -> Self {
            Self {
                invalidations: AtomicUsize::new(0),
                connected: true,
            }
        }
    }

    impl TokenSource for FakeTokens {
        fn access_token(&self) -> Result<String, String> {
            Ok(format!("ya29.token-{}", self.invalidations.load(Ordering::SeqCst)))
        }
        fn invalidate(&self) {
            self.invalidations.fetch_add(1, Ordering::SeqCst);
        }
        fn is_connected(&self) -> bool {
            self.connected
        }
        fn account(&self) -> Option<String> {
            Some("someone@example.com".to_string())
        }
    }

    fn drive(transport: MockTransport) -> GoogleDrive<MockTransport, FakeTokens> {
        GoogleDrive::new(transport, FakeTokens::new())
    }

    /// A drive whose folder id is already known, so a test about uploading is
    /// not also a test about folder bootstrap.
    fn drive_with_root(transport: MockTransport) -> GoogleDrive<MockTransport, FakeTokens> {
        let drive = drive(transport);
        *drive.root_folder.lock().unwrap() = Some("root-folder-id".to_string());
        drive
    }

    fn body_text(request: &HttpRequest) -> String {
        String::from_utf8_lossy(request.body.as_deref().unwrap_or(b"")).into_owned()
    }

    // -----------------------------------------------------------------
    // Listing
    // -----------------------------------------------------------------

    #[test]
    fn a_listing_is_one_query_that_carries_paths_and_digests() {
        let transport = MockTransport::new();
        transport.reply_json(
            200,
            r#"{"files":[
                {"id":"id-1","name":"week 1.notex","size":"2048","modifiedTime":"2026-09-18T12:34:56.789Z",
                 "appProperties":{"notexApp":"1","notexPath":"Maths/week 1.notex","notexSha256":"aaaa"}},
                {"id":"id-2","name":"diary.notex","size":"11","modifiedTime":"2026-01-01T00:00:00.000Z",
                 "appProperties":{"notexApp":"1","notexPath":"diary.notex","notexSha256":"bbbb"}}
            ]}"#,
        );
        let drive = drive(transport);
        let files = drive.list().unwrap();

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "Maths/week 1.notex");
        assert_eq!(files[0].digest.hash, "aaaa");
        assert_eq!(files[0].digest.bytes, 2048);
        assert_eq!(files[1].path, "diary.notex");

        // One request for a nested library: the path travels with the file, so
        // nothing has to walk parent folders to find out where things live.
        assert_eq!(drive.transport.request_count(), 1);
        let request = drive.transport.request(0);
        assert_eq!(request.method, Method::Get);
        assert!(request.url.contains("appProperties%20has"), "{}", request.url);
        assert!(request.url.contains("notexApp"), "{}", request.url);
        // Folders carry the marker too, and must not be listed as documents.
        assert!(request.url.contains("mimeType%20%21%3D"), "{}", request.url);
        assert!(request
            .headers
            .contains(&("Authorization".to_string(), "Bearer ya29.token-0".to_string())));
    }

    #[test]
    fn a_listing_follows_every_page() {
        // A library of more than 1000 documents is unusual but not absurd, and
        // stopping at page one would make every file past it look deleted —
        // which the engine would faithfully propagate.
        let transport = MockTransport::new();
        transport
            .reply_json(
                200,
                r#"{"nextPageToken":"PAGE2","files":[{"id":"a","appProperties":{"notexPath":"a.notex","notexSha256":"h1"}}]}"#,
            )
            .reply_json(200, r#"{"files":[{"id":"b","appProperties":{"notexPath":"b.notex","notexSha256":"h2"}}]}"#);

        let drive = drive(transport);
        let files = drive.list().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(drive.transport.request_count(), 2);
        assert!(drive.transport.request(1).url.contains("pageToken=PAGE2"));
        assert!(!drive.transport.request(0).url.contains("pageToken"));
        drive.transport.assert_drained();
    }

    #[test]
    fn a_file_with_no_recorded_hash_is_skipped_rather_than_guessed_at() {
        let transport = MockTransport::new();
        transport.reply_json(
            200,
            r#"{"files":[
                {"id":"ok","appProperties":{"notexPath":"a.notex","notexSha256":"h"}},
                {"id":"no-hash","appProperties":{"notexPath":"b.notex"}},
                {"id":"no-path","appProperties":{"notexSha256":"h"}},
                {"id":"nothing"}
            ]}"#,
        );
        let files = drive(transport).list().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.notex");
    }

    // -----------------------------------------------------------------
    // Upload
    // -----------------------------------------------------------------

    #[test]
    fn a_new_file_is_created_with_its_path_and_digest_in_appproperties() {
        let transport = MockTransport::new();
        transport
            // lookup_id: not there yet
            .reply_json(200, r#"{"files":[]}"#)
            // create
            .reply_json(200, r#"{"id":"new-id","modifiedTime":"2026-09-18T12:00:00.000Z"}"#);

        let drive = drive_with_root(transport);
        let digest = drive.upload("diary.notex", b"{\"format\":\"notex\"}").unwrap();

        assert_eq!(digest.hash, crate::digest::hash_bytes(b"{\"format\":\"notex\"}"));
        assert_eq!(digest.bytes, 18);
        assert_eq!(digest.modified_ms, parse_rfc3339_ms("2026-09-18T12:00:00.000Z").unwrap());

        let upload = drive.transport.request(1);
        assert_eq!(upload.method, Method::Post);
        assert!(upload.url.starts_with("https://www.googleapis.com/upload/drive/v3/files?"));
        assert!(upload.url.contains("uploadType=multipart"));

        let body = body_text(&upload);
        assert!(body.contains(&format!("\"{DIGEST_KEY}\":\"{}\"", digest.hash)), "{body}");
        assert!(body.contains("\"notexPath\":\"diary.notex\""), "{body}");
        assert!(body.contains("\"parents\":[\"root-folder-id\"]"), "{body}");
        assert!(body.contains("{\"format\":\"notex\"}"), "{body}");
        assert!(body.starts_with(&format!("--{BOUNDARY}\r\n")), "{body}");
        assert!(body.ends_with(&format!("\r\n--{BOUNDARY}--\r\n")), "{body}");
        assert!(upload
            .headers
            .iter()
            .any(|(k, v)| k == "Content-Type" && v == &format!("multipart/related; boundary={BOUNDARY}")));
    }

    #[test]
    fn a_known_file_is_updated_in_place_and_never_re_parented() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"id":"existing","modifiedTime":"2026-09-18T12:00:00.000Z"}"#);

        let drive = drive_with_root(transport);
        drive.ids.write().unwrap().insert("diary.notex".to_string(), "existing".to_string());
        drive.upload("diary.notex", b"v2").unwrap();

        // No lookup round trip, because the id was already known.
        assert_eq!(drive.transport.request_count(), 1);
        let update = drive.transport.request(0);
        assert_eq!(update.method, Method::Patch);
        assert!(update.url.contains("/upload/drive/v3/files/existing?"), "{}", update.url);
        // Drive rejects `parents` on an update with a 400, and a file the user
        // filed somewhere else in Drive must not be yanked back.
        assert!(!body_text(&update).contains("parents"), "{}", body_text(&update));
    }

    #[test]
    fn a_nested_path_creates_the_folders_it_needs_once() {
        let transport = MockTransport::new();
        transport
            .reply_json(200, r#"{"files":[]}"#) // lookup_id
            .reply_json(200, r#"{"files":[]}"#) // find_folder Maths -> missing
            .reply_json(200, r#"{"id":"maths-id"}"#) // create_folder Maths
            .reply_json(200, r#"{"id":"file-1","modifiedTime":"2026-09-18T12:00:00.000Z"}"#)
            .reply_json(200, r#"{"files":[]}"#) // lookup_id for the second file
            .reply_json(200, r#"{"id":"file-2","modifiedTime":"2026-09-18T12:00:00.000Z"}"#);

        let drive = drive_with_root(transport);
        drive.upload("Maths/week 1.notex", b"a").unwrap();
        drive.upload("Maths/week 2.notex", b"b").unwrap();

        // Six requests, not seven: the second upload reuses the cached folder
        // id rather than resolving "Maths" all over again.
        assert_eq!(drive.transport.request_count(), 6);
        assert_eq!(drive.folders.read().unwrap().get("Maths").unwrap(), "maths-id");
        let create = drive.transport.request(2);
        assert!(body_text(&create).contains(FOLDER_MIME), "{}", body_text(&create));
        assert!(body_text(&create).contains("\"parents\":[\"root-folder-id\"]"));
        assert!(body_text(&drive.transport.request(3)).contains("\"parents\":[\"maths-id\"]"));
        drive.transport.assert_drained();
    }

    #[test]
    fn the_sync_folder_is_found_before_it_is_created() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"files":[{"id":"already-there","name":"Notex Sync"}]}"#);
        let drive = drive(transport);
        assert_eq!(drive.root_folder_id().unwrap(), "already-there");
        // Cached: a second ask is free.
        assert_eq!(drive.root_folder_id().unwrap(), "already-there");
        assert_eq!(drive.transport.request_count(), 1);
        let query = drive.transport.request(0).url;
        assert!(query.contains("Notex%20Sync"), "{query}");
        assert!(query.contains("%27root%27%20in%20parents"), "{query}");
    }

    #[test]
    fn the_sync_folder_is_created_when_there_is_none() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"files":[]}"#).reply_json(200, r#"{"id":"made-it"}"#);
        let drive = drive(transport);
        assert_eq!(drive.root_folder_id().unwrap(), "made-it");
        let create = drive.transport.request(1);
        assert_eq!(create.method, Method::Post);
        let body = body_text(&create);
        assert!(body.contains("\"name\":\"Notex Sync\""), "{body}");
        assert!(body.contains(FOLDER_MIME), "{body}");
    }

    // -----------------------------------------------------------------
    // Download and delete
    // -----------------------------------------------------------------

    #[test]
    fn a_download_asks_for_the_bytes_and_not_the_metadata() {
        let transport = MockTransport::new();
        transport.reply(200, b"{\"format\":\"notex\"}".to_vec());
        let drive = drive(transport);
        drive.ids.write().unwrap().insert("a.notex".to_string(), "id-1".to_string());

        assert_eq!(drive.fetch("a.notex").unwrap(), b"{\"format\":\"notex\"}");
        // Without `alt=media` Drive answers with the file's *metadata*, which
        // would be written to disk as if it were the document.
        assert!(drive.transport.request(0).url.ends_with("/files/id-1?alt=media"));
    }

    #[test]
    fn a_download_of_an_unknown_path_looks_it_up_first() {
        let transport = MockTransport::new();
        transport
            .reply_json(200, r#"{"files":[{"id":"found"}]}"#)
            .reply(200, b"bytes".to_vec());
        let drive = drive(transport);
        assert_eq!(drive.fetch("other.notex").unwrap(), b"bytes");
        assert!(drive.transport.request(0).url.contains("notexPath"));
        assert!(drive.transport.request(1).url.contains("/files/found?alt=media"));
        // And the id is remembered, so the next call is one request.
        assert_eq!(drive.known_id("other.notex").as_deref(), Some("found"));
    }

    #[test]
    fn a_missing_file_is_a_clear_error_rather_than_an_empty_document() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"files":[]}"#);
        let error = drive(transport).fetch("gone.notex").unwrap_err();
        assert!(error.contains("gone.notex"), "{error}");
    }

    #[test]
    fn a_delete_trashes_rather_than_erasing() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"id":"id-1"}"#);
        let drive = drive(transport);
        drive.ids.write().unwrap().insert("a.notex".to_string(), "id-1".to_string());
        drive.remove("a.notex").unwrap();

        let request = drive.transport.request(0);
        assert_eq!(request.method, Method::Patch);
        assert!(body_text(&request).contains("\"trashed\":true"));
        // Drive's bin is the undo that a permanent delete would not have.
        assert!(!request.url.contains("supportsAllDrives=false"));
        assert!(drive.known_id("a.notex").is_none());
    }

    #[test]
    fn deleting_something_that_is_already_gone_succeeds() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"files":[]}"#);
        assert!(drive(transport).remove("never-existed.notex").is_ok());
    }

    // -----------------------------------------------------------------
    // Tokens and errors
    // -----------------------------------------------------------------

    #[test]
    fn a_401_refreshes_the_token_and_retries_once() {
        let transport = MockTransport::new();
        transport
            .reply_json(401, r#"{"error":{"code":401,"message":"Invalid Credentials"}}"#)
            .reply_json(200, r#"{"files":[]}"#);

        let drive = drive(transport);
        assert!(drive.list().is_ok());
        assert_eq!(drive.transport.request_count(), 2);
        // The retry carries a *different* token — otherwise it is just the
        // same rejected request sent twice.
        assert!(drive.transport.request(0).headers.contains(&("Authorization".into(), "Bearer ya29.token-0".into())));
        assert!(drive.transport.request(1).headers.contains(&("Authorization".into(), "Bearer ya29.token-1".into())));
        assert_eq!(drive.tokens.invalidations.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_second_401_is_reported_rather_than_retried_forever() {
        let transport = MockTransport::new();
        transport
            .reply_json(401, r#"{"error":{"message":"Invalid Credentials"}}"#)
            .reply_json(401, r#"{"error":{"message":"Invalid Credentials"}}"#);

        let drive = drive(transport);
        let error = drive.list().unwrap_err();
        assert!(error.contains("connect the account again"), "{error}");
        assert_eq!(drive.transport.request_count(), 2);
    }

    #[test]
    fn drive_errors_are_translated_into_something_actionable() {
        let quota = HttpResponse::new(
            403,
            r#"{"error":{"code":403,"message":"The user's Drive storageQuota has been exceeded."}}"#,
        );
        assert!(drive_error(&quota).contains("out of space"), "{}", drive_error(&quota));

        let unavailable = HttpResponse::new(503, r#"{"error":{"message":"Backend Error"}}"#);
        assert!(drive_error(&unavailable).contains("unavailable"));

        let rate = HttpResponse::new(429, r#"{"error":{"message":"Rate Limit Exceeded"}}"#);
        assert!(drive_error(&rate).contains("unavailable"));

        // Not every failure is JSON — a proxy or load balancer answers in HTML.
        let html = HttpResponse::new(502, "<html><title>502</title></html>");
        assert!(drive_error(&html).contains("502"));

        let gone = HttpResponse::new(404, r#"{"error":{"message":"File not found: abc."}}"#);
        assert!(drive_error(&gone).contains("no longer has that file"));
    }

    #[test]
    fn a_transport_failure_surfaces_as_an_error_not_a_panic() {
        let transport = MockTransport::new();
        transport.fail("dns error: no such host");
        assert!(drive(transport).list().is_err());
    }

    // -----------------------------------------------------------------
    // Conflict detection, end to end through the engine's own decision
    // -----------------------------------------------------------------

    #[test]
    fn divergent_digests_since_the_last_sync_are_a_conflict() {
        // This is the whole point of putting the hash in `appProperties`: the
        // three-way decision can be made from a listing, with nothing
        // downloaded. Local and remote have both moved off the recorded base,
        // and to different content — which must be asked about, never merged
        // or silently overwritten.
        let transport = MockTransport::new();
        transport.reply_json(
            200,
            r#"{"files":[{"id":"id-1","size":"3","modifiedTime":"2026-09-18T12:00:00.000Z",
                "appProperties":{"notexApp":"1","notexPath":"a.notex","notexSha256":"remote-hash"}}]}"#,
        );
        let remote = drive(transport).list().unwrap();
        let remote_digest = &remote[0].digest;

        let local = FileDigest {
            hash: "local-hash".to_string(),
            bytes: 3,
            modified_ms: 0,
        };
        assert_eq!(
            crate::conflict::decide(Some(&local), Some(remote_digest), Some("base-hash")),
            crate::conflict::SyncAction::Conflict
        );
        // Only the local side moved: push, no question asked.
        assert_eq!(
            crate::conflict::decide(Some(&local), Some(remote_digest), Some("remote-hash")),
            crate::conflict::SyncAction::Push
        );
        // Only the remote side moved: pull.
        assert_eq!(
            crate::conflict::decide(Some(&local), Some(remote_digest), Some("local-hash")),
            crate::conflict::SyncAction::Pull
        );
    }

    #[test]
    fn an_upload_records_the_digest_the_next_pass_compares_against() {
        // The round trip that makes the loop stable: what `upload` returns is
        // what the engine stores as the new base, and it must equal what the
        // remote will report next time.
        let transport = MockTransport::new();
        transport
            .reply_json(200, r#"{"files":[]}"#)
            .reply_json(200, r#"{"id":"new-id","modifiedTime":"2026-09-18T12:00:00.000Z"}"#);
        let drive = drive_with_root(transport);
        let bytes = b"{\"format\":\"notex\",\"pages\":[]}";
        let digest = drive.upload("a.notex", bytes).unwrap();

        let body = body_text(&drive.transport.request(1));
        assert!(body.contains(&digest.hash), "the uploaded metadata must carry the digest it reports");
        assert_eq!(digest.hash, crate::digest::hash_bytes(bytes));
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    #[test]
    fn a_quote_in_a_name_cannot_break_out_of_a_drive_query() {
        assert_eq!(escape_query("Tom's notes"), "Tom\\'s notes");
        assert_eq!(escape_query("back\\slash"), "back\\\\slash");
        assert_eq!(escape_query("plain"), "plain");
    }

    #[test]
    fn rfc3339_timestamps_parse_including_leap_days_and_centuries() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z"), Some(1_000));
        assert_eq!(parse_rfc3339_ms("2026-09-18T12:34:56.789Z"), Some(1_789_734_896_789));
        // 2000 is a leap year, 1900 is not — the case a naive %4 rule gets
        // wrong, and the reason this is not three lines of arithmetic.
        assert_eq!(
            parse_rfc3339_ms("2000-03-01T00:00:00Z").unwrap() - parse_rfc3339_ms("2000-02-28T00:00:00Z").unwrap(),
            2 * 86_400_000
        );
        assert_eq!(
            parse_rfc3339_ms("2025-03-01T00:00:00Z").unwrap() - parse_rfc3339_ms("2025-02-28T00:00:00Z").unwrap(),
            86_400_000
        );
        // A fraction of any length, truncated to milliseconds.
        assert_eq!(parse_rfc3339_ms("2026-09-18T12:34:56.7Z"), Some(1_789_734_896_700));
        assert_eq!(parse_rfc3339_ms("2026-09-18T12:34:56.789123Z"), Some(1_789_734_896_789));

        assert_eq!(parse_rfc3339_ms("2026-09-18T12:34:56+02:00"), None);
        assert_eq!(parse_rfc3339_ms("not a date"), None);
        assert_eq!(parse_rfc3339_ms("2026-13-01T00:00:00Z"), None);
        // Before the epoch: unrepresentable as unsigned ms, and never real for
        // a file this app wrote.
        assert_eq!(parse_rfc3339_ms("1969-12-31T23:59:59Z"), None);
    }

    #[test]
    fn a_multipart_body_frames_both_parts_exactly_once() {
        let body = GoogleDrive::<MockTransport, FakeTokens>::multipart("{\"name\":\"a\"}", b"BYTES");
        let text = String::from_utf8_lossy(&body);
        assert_eq!(text.matches(&format!("--{BOUNDARY}\r\n")).count(), 2);
        assert_eq!(text.matches(&format!("--{BOUNDARY}--\r\n")).count(), 1);
        assert!(text.contains("Content-Type: application/json; charset=UTF-8\r\n\r\n{\"name\":\"a\"}"));
        assert!(text.contains(&format!("Content-Type: {NOTEX_MIME}\r\n\r\nBYTES")));
    }

    #[test]
    fn the_provider_names_the_account_it_is_signed_in_as() {
        let drive = drive(MockTransport::new());
        assert_eq!(drive.name(), "Google Drive (someone@example.com)");
        assert!(drive.is_connected());
    }
}
