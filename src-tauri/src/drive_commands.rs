//! IPC for connecting a Google Drive account.
//!
//! Thin, like the rest of the command layer: PKCE, the authorization URL, the
//! token exchange, the loopback listener and the Drive REST client all live in
//! `notes-sync`, where they are tested without a webview or a network. What is
//! here is the part that genuinely needs Tauri — opening the system browser,
//! persisting tokens through the store plugin, and swapping the live provider
//! into the sync manager.
//!
//! The two platforms complete the sign-in differently, and that is the only
//! real branch in this file:
//!
//! - **Desktop** binds a loopback port, waits on it, and finishes the exchange
//!   in the same background thread. The user does nothing but consent.
//! - **Android** cannot bind a port a browser will reach, so the redirect comes
//!   back as an `ACTION_VIEW` intent on a custom scheme. `MainActivity` hands
//!   the URI to the page and the page calls [`drive_complete_sign_in`].
//!
//! Both paths end in the same place, and both check the `state` they started
//! with before redeeming anything.

use std::sync::{Arc, Mutex};

use notes_sync::{
    account::DriveAccount,
    drive::{GoogleDrive, TokenSource},
    http::{HttpRequest, HttpTransport},
    loopback::RedirectListener,
    oauth::{self, AuthSession, Pkce, RedirectTarget, TokenSet},
    CloudProvider, OfflineProvider,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::library_commands::{Library, SYNC_STATUS_EVENT};

/// Where the refresh token is kept between runs, through `tauri-plugin-store`.
const STORE_FILE: &str = "google-drive.json";
const TOKENS_KEY: &str = "tokens";

/// Emitted when the account connects or disconnects, so the Cloud Sync panel
/// follows a sign-in that finished in a browser window rather than in the app.
pub const DRIVE_ACCOUNT_EVENT: &str = "drive://account";

/// The OAuth client id for this application.
///
/// Baked in at build time from `NOTEX_GOOGLE_CLIENT_ID`, and **not a secret**:
/// an installed app is a public OAuth client, which is the entire reason this
/// flow uses PKCE instead of a client secret. Anyone can read it out of the
/// binary and it buys them nothing, because redeeming a code also needs the
/// verifier that never left this process.
///
/// Empty in a build that was not given one, and every entry point says so
/// rather than sending Google a request that can only fail.
const CLIENT_ID: &str = match option_env!("NOTEX_GOOGLE_CLIENT_ID") {
    Some(id) => id,
    None => "",
};

/// The custom scheme Android claims for the redirect. Must match the
/// `<intent-filter>` in `AndroidManifest.xml` and the redirect URI registered
/// with Google.
pub const ANDROID_SCHEME: &str = "com.notex.app";

fn client_id() -> Result<String, String> {
    // A runtime override first, so someone can point a build at their own
    // Google Cloud project without rebuilding it.
    if let Ok(id) = std::env::var("NOTEX_GOOGLE_CLIENT_ID") {
        if !id.trim().is_empty() {
            return Ok(id.trim().to_string());
        }
    }
    if CLIENT_ID.trim().is_empty() {
        return Err(
            "This build has no Google OAuth client id. Build with NOTEX_GOOGLE_CLIENT_ID set to the \
             client id of a Google Cloud project with the Drive API enabled."
                .to_string(),
        );
    }
    Ok(CLIENT_ID.trim().to_string())
}

/// 32 bytes of real entropy for a PKCE verifier or an OAuth `state`.
fn entropy() -> Result<[u8; 32], String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Cannot generate a secure value for the sign-in: {e}"))?;
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct Drive {
    pub account: Arc<DriveAccount<Box<dyn HttpTransport>>>,
    /// The sign-in that is waiting for a redirect, if any. Android's answer
    /// arrives in a separate command, so the verifier has to outlive the call
    /// that created it.
    pending: Mutex<Option<AuthSession>>,
}

impl Drive {
    pub fn new(app: &AppHandle) -> Self {
        let stored = load_tokens(app);
        let handle = app.clone();
        let account = DriveAccount::new(
            crate::transport::network(),
            client_id().unwrap_or_default(),
            stored,
            Box::new(move |tokens| {
                save_tokens(&handle, tokens);
                let _ = handle.emit(DRIVE_ACCOUNT_EVENT, describe(tokens));
            }),
        );
        Self {
            account: Arc::new(account),
            pending: Mutex::new(None),
        }
    }
}

/// What the Cloud Sync panel shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveAccountInfo {
    pub connected: bool,
    /// The signed-in email, when it is known.
    pub account: String,
    /// False when consent was given without the Drive scope, which otherwise
    /// only shows up as a 403 on the first upload.
    pub has_drive_access: bool,
    /// False in a build with no client id, so the UI can explain rather than
    /// offering a button that cannot work.
    pub configured: bool,
}

fn describe(tokens: Option<&TokenSet>) -> DriveAccountInfo {
    DriveAccountInfo {
        connected: tokens.is_some(),
        account: tokens.map(|t| t.account.clone()).unwrap_or_default(),
        has_drive_access: tokens.map(TokenSet::has_drive_scope).unwrap_or(false),
        configured: client_id().is_ok(),
    }
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

/// Read the stored token set.
///
/// A store that will not open, or holds something from an older shape, is
/// treated as "no account": the worst case is one sign-in, and refusing to
/// start because a cache is unreadable would be far worse.
fn load_tokens(app: &AppHandle) -> Option<TokenSet> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_FILE).ok()?;
    let value = store.get(TOKENS_KEY)?;
    serde_json::from_value::<TokenSet>(value).ok()
}

fn save_tokens(app: &AppHandle, tokens: Option<&TokenSet>) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(STORE_FILE) else { return };
    match tokens {
        Some(tokens) => {
            if let Ok(value) = serde_json::to_value(tokens) {
                store.set(TOKENS_KEY, value);
            }
        }
        None => {
            store.delete(TOKENS_KEY);
        }
    }
    let _ = store.save();
}

// ---------------------------------------------------------------------------
// Provider wiring
// ---------------------------------------------------------------------------

/// Point the sync manager at Drive, or back at nothing.
///
/// Called after a sign-in, after a sign-out, and once at startup for an
/// account restored from the store — so a device that was connected yesterday
/// is connected again on launch without anyone touching a button.
pub fn attach_provider(app: &AppHandle) {
    let Some(drive) = app.try_state::<Drive>() else { return };
    let Some(library) = app.try_state::<Library>() else { return };

    if drive.account.is_connected() {
        let provider = GoogleDrive::new(crate::transport::network(), Arc::clone(&drive.account));
        library.manager.set_provider(Box::new(provider) as Box<dyn CloudProvider>);
    } else {
        library.manager.set_provider(Box::new(OfflineProvider));
    }
}

/// Finish a sign-in: redeem the code, look up the account, go live.
fn redeem(app: &AppHandle, session: &AuthSession, code: &str) -> Result<DriveAccountInfo, String> {
    let drive = app.state::<Drive>();
    let transport = crate::transport::network();

    let response = transport.send(HttpRequest::post(oauth::GOOGLE_TOKEN_ENDPOINT).form(&session.exchange_fields(code)))?;
    if !response.is_success() {
        return Err(notes_sync::drive::drive_error(&response));
    }
    let mut tokens = oauth::parse_token_response(&response.body, notes_sync::now_ms(), None)?;

    if !tokens.has_drive_scope() {
        return Err("KK-Notes was not given access to Google Drive. Sign in again and leave the Drive permission ticked.".to_string());
    }

    // Best effort: an account with no email still syncs, it just shows as
    // "Google Drive" rather than naming who is signed in.
    if let Ok(response) = transport.send(HttpRequest::get(oauth::GOOGLE_USERINFO_ENDPOINT).bearer(&tokens.access_token)) {
        if response.is_success() {
            if let Some(email) = oauth::parse_account_email(&response.body) {
                tokens.account = email;
            }
        }
    }

    drive.account.connect(tokens);
    attach_provider(app);

    let info = describe(drive.account.tokens().as_ref());
    // Sync straight away, so the library fills in rather than sitting empty
    // until something happens to touch a file.
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(library) = handle.try_state::<Library>() {
            let status = library.manager.sync_once();
            let _ = handle.emit(SYNC_STATUS_EVENT, &status);
        }
    });
    Ok(info)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn drive_account(drive: State<'_, Drive>) -> DriveAccountInfo {
    describe(drive.account.tokens().as_ref())
}

/// Start a sign-in.
///
/// Returns as soon as the browser has been opened. On the desktop a background
/// thread is already waiting on the loopback port and will emit
/// [`DRIVE_ACCOUNT_EVENT`] when the user consents; on Android the page calls
/// [`drive_complete_sign_in`] with the redirect the intent delivered.
#[tauri::command]
pub fn drive_sign_in(app: AppHandle, drive: State<'_, Drive>) -> Result<String, String> {
    let client_id = client_id()?;
    let pkce = Pkce::from_entropy(entropy()?);
    let state = oauth::base64_url(&entropy()?);

    // Android has no port a browser will reach; the desktop does, and a
    // loopback redirect is what RFC 8252 asks for where one is possible.
    let mobile = cfg!(any(target_os = "android", target_os = "ios"));
    let listener = if mobile { None } else { RedirectListener::bind().ok() };

    let target = match &listener {
        Some(listener) => RedirectTarget::Loopback { port: listener.port() },
        None => RedirectTarget::CustomScheme {
            scheme: ANDROID_SCHEME.to_string(),
        },
    };

    let session = AuthSession::new(client_id, &target, pkce, state.clone());
    let url = session.authorization_url();
    *drive.pending.lock().unwrap() = Some(session.clone());

    if let Some(listener) = listener {
        let handle = app.clone();
        std::thread::spawn(move || {
            let outcome = listener.wait(&state).and_then(|auth| redeem(&handle, &session, &auth.code));
            // The window may be behind a browser tab, so the result has to
            // arrive as an event rather than as this command's return value.
            let _ = match outcome {
                Ok(info) => handle.emit(DRIVE_ACCOUNT_EVENT, info),
                Err(message) => handle.emit(
                    DRIVE_ACCOUNT_EVENT,
                    serde_json::json!({ "connected": false, "account": "", "hasDriveAccess": false,
                                        "configured": true, "error": message }),
                ),
            };
        });
    }

    // The *system* browser, not the app's webview: RFC 8252 §8.12, and Google
    // refuses an embedded one outright.
    open_in_browser(&app, &url)?;
    Ok(url)
}

/// Finish an Android sign-in from the redirect the intent delivered.
#[tauri::command]
pub fn drive_complete_sign_in(app: AppHandle, redirect: String) -> Result<DriveAccountInfo, String> {
    let session = {
        let drive = app.state::<Drive>();
        let pending = drive.pending.lock().unwrap().clone();
        pending.ok_or_else(|| "There is no sign-in waiting for that redirect.".to_string())?
    };

    let auth = oauth::parse_redirect(&redirect)?;
    if auth.state != session.state {
        return Err("That redirect did not belong to this sign-in.".to_string());
    }

    let info = redeem(&app, &session, &auth.code)?;
    *app.state::<Drive>().pending.lock().unwrap() = None;
    Ok(info)
}

/// Disconnect the account.
///
/// Revoking is attempted but never required: signing out has to work on a
/// plane, and a token that cannot be revoked now is still discarded here.
#[tauri::command]
pub fn drive_sign_out(app: AppHandle, drive: State<'_, Drive>) -> DriveAccountInfo {
    if let Some(tokens) = drive.account.tokens() {
        let transport = crate::transport::network();
        let _ = transport.send(
            HttpRequest::post(oauth::GOOGLE_REVOKE_ENDPOINT).form(&[("token", tokens.refresh_token.as_str())]),
        );
    }
    drive.account.disconnect();
    attach_provider(&app);
    describe(None)
}

fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Cannot open the browser to sign in: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_with_no_client_id_says_so_rather_than_failing_at_google() {
        // `client_id()` reads the environment first, so this asserts the
        // message rather than the build's own value.
        if client_id().is_err() {
            let error = client_id().unwrap_err();
            assert!(error.contains("NOTEX_GOOGLE_CLIENT_ID"), "{error}");
        }
    }

    #[test]
    fn a_disconnected_account_describes_itself_honestly() {
        let info = describe(None);
        assert!(!info.connected);
        assert!(!info.has_drive_access);
        assert!(info.account.is_empty());
    }

    #[test]
    fn a_connected_account_carries_its_email_and_scope() {
        let tokens = TokenSet {
            access_token: "ya29".into(),
            refresh_token: "1//r".into(),
            expires_at_ms: 0,
            scope: oauth::DRIVE_FILE_SCOPE.into(),
            account: "someone@example.com".into(),
        };
        let info = describe(Some(&tokens));
        assert!(info.connected);
        assert!(info.has_drive_access);
        assert_eq!(info.account, "someone@example.com");

        // Consent given with the Drive box unticked: connected, but it cannot
        // sync, and saying so here beats a 403 on the first upload.
        let narrow = TokenSet {
            scope: oauth::USERINFO_EMAIL_SCOPE.into(),
            ..tokens
        };
        assert!(describe(Some(&narrow)).connected);
        assert!(!describe(Some(&narrow)).has_drive_access);
    }

    #[test]
    fn the_android_scheme_matches_the_redirect_the_manifest_claims() {
        // These three have to agree: the manifest's intent filter, the URI
        // sent to Google, and what is registered in the Cloud console. A
        // mismatch is a `redirect_uri_mismatch` that names none of them.
        let target = RedirectTarget::CustomScheme {
            scheme: ANDROID_SCHEME.to_string(),
        };
        assert_eq!(target.uri(), "com.notex.app:/oauth2redirect");
    }

    #[test]
    fn entropy_is_not_a_constant() {
        let (a, b) = (entropy().unwrap(), entropy().unwrap());
        assert_ne!(a, b, "two sign-ins must not share a verifier");
        assert_ne!(a, [0_u8; 32]);
    }
}
