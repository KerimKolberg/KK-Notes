//! The connected Google account: tokens in, access tokens out.
//!
//! This is the piece that sits between the OAuth exchange and the Drive
//! provider. It holds the token set, hands out an access token, notices when
//! one has expired and renews it, and tells whoever owns persistence that
//! something changed. Two things it deliberately does *not* do: touch the
//! filesystem, or know what Tauri is — so the refresh-on-expiry behaviour, the
//! thundering-herd guard and the "a revoked token disconnects the account"
//! rule are all testable against a scripted transport rather than against
//! Google.

use std::sync::{Mutex, RwLock};

use crate::{
    digest::now_ms,
    drive::TokenSource,
    http::{HttpRequest, HttpTransport},
    oauth::{self, TokenSet},
};

/// Called whenever the token set changes, so the shell can write it out.
/// `None` means the account was disconnected and anything stored should go.
pub type OnChange = Box<dyn Fn(Option<&TokenSet>) + Send + Sync>;

pub struct DriveAccount<T: HttpTransport> {
    transport: T,
    client_id: String,
    tokens: RwLock<Option<TokenSet>>,
    /// Held across a refresh so two threads that both notice an expiry make
    /// one request between them, not two. The second one finds a fresh token
    /// waiting and returns it.
    refreshing: Mutex<()>,
    on_change: OnChange,
}

impl<T: HttpTransport> DriveAccount<T> {
    pub fn new(transport: T, client_id: impl Into<String>, tokens: Option<TokenSet>, on_change: OnChange) -> Self {
        Self {
            transport,
            client_id: client_id.into(),
            tokens: RwLock::new(tokens),
            refreshing: Mutex::new(()),
            on_change,
        }
    }

    /// Replace the token set after a successful sign-in.
    pub fn connect(&self, tokens: TokenSet) {
        *self.tokens.write().unwrap() = Some(tokens);
        let guard = self.tokens.read().unwrap();
        (self.on_change)(guard.as_ref());
    }

    /// Forget the account. Does not revoke — that is a network call the caller
    /// makes if it can, and signing out must work with no network at all.
    pub fn disconnect(&self) {
        *self.tokens.write().unwrap() = None;
        (self.on_change)(None);
    }

    pub fn tokens(&self) -> Option<TokenSet> {
        self.tokens.read().unwrap().clone()
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Trade a refresh token for a new access token.
    fn refresh(&self) -> Result<String, String> {
        let _guard = self.refreshing.lock().unwrap();

        // Whoever held the lock before us may already have done the work.
        let current = self.tokens().ok_or_else(|| NOT_CONNECTED.to_string())?;
        if !current.needs_refresh(now_ms()) {
            return Ok(current.access_token);
        }
        if current.refresh_token.is_empty() {
            self.disconnect();
            return Err("The Google account needs to be connected again.".to_string());
        }

        let request = HttpRequest::post(oauth::GOOGLE_TOKEN_ENDPOINT)
            .form(&oauth::refresh_fields(&self.client_id, &current.refresh_token));
        let response = self.transport.send(request)?;

        if !response.is_success() {
            // A refresh token is good until it is revoked, so a 400 or 401 here
            // means it *was* revoked — from Google's account page, by changing
            // a password, or by the app being removed. Retrying that forever
            // would leave a permanently "syncing" account that never will be;
            // dropping it puts an honest "Sign in" button back on screen.
            if matches!(response.status, 400 | 401) {
                self.disconnect();
                return Err("Google has signed this device out. Connect the account again.".to_string());
            }
            return Err(crate::drive::drive_error(&response));
        }

        let mut renewed = oauth::parse_token_response(&response.body, now_ms(), Some(&current.refresh_token))?;
        // A refresh response says nothing about the account, and losing the
        // email would blank the name in the UI on the hour.
        renewed.account = current.account.clone();
        let access = renewed.access_token.clone();
        self.connect(renewed);
        Ok(access)
    }
}

const NOT_CONNECTED: &str = "No Google account is connected.";

impl<T: HttpTransport> TokenSource for DriveAccount<T> {
    fn access_token(&self) -> Result<String, String> {
        let current = self.tokens().ok_or_else(|| NOT_CONNECTED.to_string())?;
        if current.needs_refresh(now_ms()) {
            return self.refresh();
        }
        Ok(current.access_token)
    }

    fn invalidate(&self) {
        // Mark the access token spent without dropping the refresh token, so
        // the next call renews rather than disconnecting.
        let mut guard = self.tokens.write().unwrap();
        if let Some(tokens) = guard.as_mut() {
            tokens.expires_at_ms = 0;
        }
    }

    fn is_connected(&self) -> bool {
        self.tokens.read().unwrap().is_some()
    }

    fn account(&self) -> Option<String> {
        self.tokens
            .read()
            .unwrap()
            .as_ref()
            .map(|tokens| tokens.account.clone())
            .filter(|account| !account.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::test_support::MockTransport;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn tokens(expires_at_ms: u64) -> TokenSet {
        TokenSet {
            access_token: "ya29.old".into(),
            refresh_token: "1//refresh".into(),
            expires_at_ms,
            scope: oauth::DRIVE_FILE_SCOPE.into(),
            account: "someone@example.com".into(),
        }
    }

    fn account(transport: MockTransport, tokens: Option<TokenSet>) -> (DriveAccount<MockTransport>, Arc<AtomicUsize>) {
        let writes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&writes);
        let account = DriveAccount::new(
            transport,
            "client-id",
            tokens,
            Box::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        (account, writes)
    }

    #[test]
    fn a_live_token_is_handed_back_without_a_round_trip() {
        let (account, writes) = account(MockTransport::new(), Some(tokens(now_ms() + 3_600_000)));
        assert_eq!(account.access_token().unwrap(), "ya29.old");
        assert_eq!(account.transport.request_count(), 0);
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_expired_token_is_refreshed_and_persisted() {
        let transport = MockTransport::new();
        transport.reply_json(
            200,
            r#"{"access_token":"ya29.new","expires_in":3599,"scope":"https://www.googleapis.com/auth/drive.file","token_type":"Bearer"}"#,
        );
        let (account, writes) = account(transport, Some(tokens(0)));

        assert_eq!(account.access_token().unwrap(), "ya29.new");
        let request = account.transport.request(0);
        assert_eq!(request.url, oauth::GOOGLE_TOKEN_ENDPOINT);
        let body = String::from_utf8(request.body.unwrap()).unwrap();
        assert!(body.contains("grant_type=refresh_token"), "{body}");
        assert!(body.contains("refresh_token=1%2F%2Frefresh"), "{body}");

        // Persisted, or the next launch would refresh all over again.
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        let stored = account.tokens().unwrap();
        // The refresh token survives a response that did not repeat it, and so
        // does the email — a refresh reply mentions neither.
        assert_eq!(stored.refresh_token, "1//refresh");
        assert_eq!(stored.account, "someone@example.com");
        assert!(stored.expires_at_ms > now_ms());
    }

    #[test]
    fn a_revoked_refresh_token_disconnects_instead_of_retrying_forever() {
        let transport = MockTransport::new();
        transport.reply_json(400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#);
        let (account, writes) = account(transport, Some(tokens(0)));

        let error = account.access_token().unwrap_err();
        assert!(error.contains("Connect the account again"), "{error}");
        // The account is gone, so the UI offers signing in rather than
        // reporting a sync error once a minute forever.
        assert!(!account.is_connected());
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_server_error_during_refresh_keeps_the_account() {
        // Google being down is not the user being signed out. Dropping the
        // refresh token here would turn a five-minute outage into a
        // reconnection on every device.
        let transport = MockTransport::new();
        transport.reply_json(503, r#"{"error":{"message":"Backend Error"}}"#);
        let (account, _) = account(transport, Some(tokens(0)));

        assert!(account.access_token().is_err());
        assert!(account.is_connected());
        assert_eq!(account.tokens().unwrap().refresh_token, "1//refresh");
    }

    #[test]
    fn invalidating_renews_rather_than_disconnecting() {
        // What a 401 from Drive triggers: the access token is spent, but the
        // account is fine and the refresh token still works.
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"access_token":"ya29.after-401","expires_in":3599}"#);
        let (account, _) = account(transport, Some(tokens(now_ms() + 3_600_000)));

        assert_eq!(account.access_token().unwrap(), "ya29.old");
        account.invalidate();
        assert!(account.is_connected());
        assert_eq!(account.access_token().unwrap(), "ya29.after-401");
    }

    #[test]
    fn two_threads_noticing_the_same_expiry_refresh_once_between_them() {
        // The sync pass and a manual "sync now" can land together. Two
        // refreshes would work, but the second one's response invalidates the
        // first one's access token on some providers, and it is a request
        // nobody needed.
        let transport = MockTransport::new();
        transport.reply_with(|_| {
            std::thread::sleep(std::time::Duration::from_millis(50));
            Ok(crate::http::HttpResponse::new(
                200,
                br#"{"access_token":"ya29.new","expires_in":3599}"#.to_vec(),
            ))
        });
        let (account, _) = account(transport, Some(tokens(0)));
        let account = Arc::new(account);

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let account = Arc::clone(&account);
                std::thread::spawn(move || account.access_token())
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap().unwrap(), "ya29.new");
        }
        assert_eq!(account.transport.request_count(), 1);
    }

    #[test]
    fn a_disconnected_account_refuses_rather_than_pretending() {
        let (account, writes) = account(MockTransport::new(), None);
        assert!(!account.is_connected());
        assert!(account.account().is_none());
        assert!(account.access_token().is_err());

        account.connect(tokens(now_ms() + 1_000_000));
        assert!(account.is_connected());
        assert_eq!(account.account().as_deref(), Some("someone@example.com"));
        assert_eq!(writes.load(Ordering::SeqCst), 1);

        account.disconnect();
        assert!(!account.is_connected());
        // Signing out has to work with no network, so it never calls one.
        assert_eq!(account.transport.request_count(), 0);
        assert_eq!(writes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn an_account_with_no_refresh_token_asks_to_be_reconnected() {
        let (account, _) = account(
            MockTransport::new(),
            Some(TokenSet {
                refresh_token: String::new(),
                ..tokens(0)
            }),
        );
        let error = account.access_token().unwrap_err();
        assert!(error.contains("connected again"), "{error}");
        assert!(!account.is_connected());
    }
}
