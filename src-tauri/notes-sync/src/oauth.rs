//! OAuth 2.0 with PKCE, as pure functions.
//!
//! A desktop or mobile app is a *public* client: whatever it is shipped with,
//! the user can read out of the binary, so there is no client secret worth
//! having. PKCE (RFC 7636) is what replaces it. The app invents a high-entropy
//! `code_verifier`, sends only its SHA-256 (the `code_challenge`) to the
//! authorization endpoint, and produces the verifier itself when redeeming the
//! code. An attacker who intercepts the redirect — a malicious app registered
//! for the same custom scheme, another process racing for the loopback port —
//! holds a code that cannot be exchanged without a secret it never saw.
//!
//! Everything here is a pure function of its inputs, including the verifier,
//! which takes its entropy as an argument rather than reaching for the system
//! RNG. That is not ceremony: it makes the challenge derivation testable
//! against RFC 7636's own published vector, which is the one way to be sure
//! this interoperates before pointing it at Google.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::http::query_url;

pub const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
pub const GOOGLE_USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

/// Per-file access, not "see all your Drive".
///
/// `drive.file` grants the app exactly the files it creates or that the user
/// hands it through the picker, and nothing else. A notes app has no business
/// reading a tax return, and the broader scopes are also the ones Google
/// subjects to an annual security assessment — so this is both the honest
/// scope and the shippable one.
pub const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
/// Asked for alongside it only so the UI can say *which* account is connected.
pub const USERINFO_EMAIL_SCOPE: &str = "https://www.googleapis.com/auth/userinfo.email";

/// Treat a token as expired this long before it really is, so a request that
/// is built now and answered in a second does not land just past the edge.
pub const EXPIRY_SKEW_MS: u64 = 60_000;

/// base64url without padding (RFC 4648 §5), which is what PKCE and JWTs use.
pub fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 63] as char);
        }
    }
    out
}

/// A verifier and the challenge derived from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    /// Kept by the app and never sent until the code is redeemed.
    pub verifier: String,
    /// `BASE64URL(SHA256(ASCII(verifier)))`.
    pub challenge: String,
}

impl Pkce {
    /// Derive a pair from 32 bytes of entropy.
    ///
    /// 32 bytes becomes a 43-character verifier, the minimum RFC 7636 allows
    /// and the length Google's own samples use. The caller supplies the bytes
    /// so this stays a pure function; the shell passes `getrandom`.
    pub fn from_entropy(entropy: [u8; 32]) -> Self {
        Self::from_verifier(base64_url(&entropy))
    }

    pub fn from_verifier(verifier: impl Into<String>) -> Self {
        let verifier = verifier.into();
        let challenge = base64_url(&Sha256::digest(verifier.as_bytes()));
        Self { verifier, challenge }
    }
}

/// Where Google should send the user back to.
///
/// The two shapes are not interchangeable, and which one is legal depends on
/// the OAuth client type registered with Google, not on a preference here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedirectTarget {
    /// Desktop: `http://127.0.0.1:<port>/oauth2redirect`, answered by a
    /// listener this app opens for the length of the sign-in and then closes.
    Loopback { port: u16 },
    /// Android: a custom scheme claimed by an intent filter, e.g.
    /// `com.notex.app:/oauth2redirect`.
    CustomScheme { scheme: String },
}

impl RedirectTarget {
    pub fn uri(&self) -> String {
        match self {
            // Loopback *must* be `127.0.0.1` rather than `localhost`: RFC 8252
            // §8.3 requires the literal address, because `localhost` can
            // resolve through a resolver an attacker controls.
            RedirectTarget::Loopback { port } => format!("http://127.0.0.1:{port}/oauth2redirect"),
            // One slash, not two. Google treats the scheme's path as opaque
            // and registers `com.notex.app:/oauth2redirect`; Android's intent
            // filter matches either, so the stricter form is the one to send.
            RedirectTarget::CustomScheme { scheme } => format!("{scheme}:/oauth2redirect"),
        }
    }
}

/// Everything needed to start a sign-in, and to finish it later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSession {
    pub client_id: String,
    pub redirect_uri: String,
    pub pkce: Pkce,
    /// Opaque value echoed back in the redirect. Anything that arrives without
    /// it, or with the wrong one, is not the reply to *this* sign-in.
    pub state: String,
    pub scopes: Vec<String>,
}

impl AuthSession {
    pub fn new(client_id: impl Into<String>, redirect: &RedirectTarget, pkce: Pkce, state: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            redirect_uri: redirect.uri(),
            pkce,
            state: state.into(),
            scopes: vec![DRIVE_FILE_SCOPE.to_string(), USERINFO_EMAIL_SCOPE.to_string()],
        }
    }

    /// The URL to open in the system browser.
    ///
    /// The *system* browser, never an embedded webview: RFC 8252 §8.12 is
    /// explicit about it, and Google rejects sign-ins from an in-app webview
    /// outright. The user needs to see the real address bar and their existing
    /// session, and the app must not be in a position to read the password.
    pub fn authorization_url(&self) -> String {
        query_url(
            GOOGLE_AUTH_ENDPOINT,
            &[
                ("client_id", &self.client_id),
                ("redirect_uri", &self.redirect_uri),
                ("response_type", "code"),
                ("scope", &self.scopes.join(" ")),
                ("code_challenge", &self.pkce.challenge),
                ("code_challenge_method", "S256"),
                ("state", &self.state),
                // Without this Google only ever issues a refresh token on the
                // *first* consent, so a reinstall would come back with an
                // access token that dies in an hour and no way to renew it.
                ("access_type", "offline"),
                ("prompt", "consent"),
            ],
        )
    }

    /// The form body that trades the authorization code for tokens.
    pub fn exchange_fields<'a>(&'a self, code: &'a str) -> Vec<(&'a str, &'a str)> {
        vec![
            ("client_id", self.client_id.as_str()),
            ("code", code),
            ("code_verifier", self.pkce.verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", self.redirect_uri.as_str()),
        ]
    }
}

/// The form body that renews an access token.
pub fn refresh_fields<'a>(client_id: &'a str, refresh_token: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ]
}

/// What came back on the redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthCode {
    pub code: String,
    pub state: String,
}

/// Read the `code` and `state` out of a redirect URI's query.
///
/// Takes the whole URI or just the query part, because the two platforms hand
/// it over differently: the loopback listener sees a request line, Android an
/// intent data URI.
pub fn parse_redirect(uri_or_query: &str) -> Result<AuthCode, String> {
    let query = uri_or_query.split_once('?').map(|(_, q)| q).unwrap_or(uri_or_query);
    let query = query.split('#').next().unwrap_or(query);

    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut description = None;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            "error_description" => description = Some(value),
            _ => {}
        }
    }

    if let Some(error) = error {
        // The one the user causes on purpose, said plainly rather than as a
        // protocol code they never asked to see.
        if error == "access_denied" {
            return Err("Sign-in was cancelled.".to_string());
        }
        return Err(match description {
            Some(detail) => format!("Google refused the sign-in: {detail} ({error})"),
            None => format!("Google refused the sign-in: {error}"),
        });
    }

    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() => Ok(AuthCode { code, state }),
        _ => Err("That redirect carried no authorization code.".to_string()),
    }
}

/// Undo `percent_encode`, and turn `+` back into a space.
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(&value[i + 1..i + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    // Not a valid escape: keep the '%' rather than losing it.
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The tokens, and when the access one stops working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    /// Issued once, at the first consent, and good until it is revoked. This
    /// is the part that must be stored; the access token is disposable.
    pub refresh_token: String,
    /// Unix epoch ms at which the access token expires.
    pub expires_at_ms: u64,
    /// What Google actually granted, which can be less than what was asked.
    pub scope: String,
    /// The signed-in account, for the UI. Empty until it has been looked up.
    #[serde(default)]
    pub account: String,
}

impl TokenSet {
    /// Is the access token unusable (or about to be)?
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.access_token.is_empty() || now_ms + EXPIRY_SKEW_MS >= self.expires_at_ms
    }

    /// Did the user actually grant Drive access?
    ///
    /// Google's consent screen lets someone untick an individual scope, and
    /// the response then says so. Finding out here is much kinder than the
    /// first upload failing with a 403 the user cannot act on.
    pub fn has_drive_scope(&self) -> bool {
        self.scope.split_whitespace().any(|s| s == DRIVE_FILE_SCOPE)
    }
}

/// Parse a token endpoint response.
///
/// `previous_refresh` is carried forward because a *refresh* response does not
/// repeat the refresh token. Losing it there would silently turn a connected
/// account into one that dies at the next expiry.
pub fn parse_token_response(body: &[u8], now_ms: u64, previous_refresh: Option<&str>) -> Result<TokenSet, String> {
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|e| format!("The token response was not JSON: {e}"))?;

    if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
        let detail = value.get("error_description").and_then(|d| d.as_str()).unwrap_or(error);
        return Err(format!("Google refused the token request: {detail}"));
    }

    let access_token = value
        .get("access_token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "The token response carried no access token.".to_string())?;

    let refresh_token = value
        .get("refresh_token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or_else(|| previous_refresh.map(str::to_string))
        .unwrap_or_default();

    // Google always sends `expires_in`; treat a missing one as already stale
    // rather than as forever, so the failure mode is one extra refresh.
    let expires_in = value.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(0);

    Ok(TokenSet {
        access_token: access_token.to_string(),
        refresh_token,
        expires_at_ms: now_ms + expires_in * 1_000,
        scope: value
            .get("scope")
            .and_then(|s| s.as_str())
            .unwrap_or(DRIVE_FILE_SCOPE)
            .to_string(),
        account: String::new(),
    })
}

/// Pull the email out of a `userinfo` response, if it is there.
pub fn parse_account_email(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    value
        .get("email")
        .and_then(|e| e.as_str())
        .filter(|e| !e.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_the_rfc_vectors_and_never_pads() {
        assert_eq!(base64_url(b""), "");
        assert_eq!(base64_url(b"f"), "Zg");
        assert_eq!(base64_url(b"fo"), "Zm8");
        assert_eq!(base64_url(b"foo"), "Zm9v");
        assert_eq!(base64_url(b"foob"), "Zm9vYg");
        assert_eq!(base64_url(b"fooba"), "Zm9vYmE");
        assert_eq!(base64_url(b"foobar"), "Zm9vYmFy");
        // The two characters that differ from standard base64, which is the
        // whole reason this is not `base64::encode`: a '+' or '/' in a
        // challenge would be mangled by the query encoder.
        assert_eq!(base64_url(&[0xfb, 0xff, 0xfe]), "-__-");
        assert!(!base64_url(b"f").contains('='));
    }

    #[test]
    fn the_pkce_challenge_matches_rfc_7636s_published_vector() {
        // RFC 7636 appendix B. If this passes, the derivation interoperates;
        // if it does not, every sign-in fails with "invalid_grant" and no clue.
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn a_verifier_from_32_bytes_is_43_unreserved_characters() {
        let pkce = Pkce::from_entropy([7; 32]);
        assert_eq!(pkce.verifier.len(), 43, "RFC 7636 requires 43..=128");
        assert!(pkce
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~')));
        // Same entropy, same pair: the shell may retry a sign-in, and a
        // verifier that drifted from its challenge fails at redemption.
        assert_eq!(Pkce::from_entropy([7; 32]), pkce);
        assert_ne!(Pkce::from_entropy([8; 32]).verifier, pkce.verifier);
    }

    #[test]
    fn loopback_redirects_use_the_literal_address_rfc_8252_requires() {
        // Not "localhost": that goes through a resolver, and RFC 8252 §8.3
        // says so explicitly.
        assert_eq!(
            RedirectTarget::Loopback { port: 51_789 }.uri(),
            "http://127.0.0.1:51789/oauth2redirect"
        );
        assert_eq!(
            RedirectTarget::CustomScheme {
                scheme: "com.notex.app".to_string()
            }
            .uri(),
            "com.notex.app:/oauth2redirect"
        );
    }

    fn session() -> AuthSession {
        AuthSession::new(
            "123-abc.apps.googleusercontent.com",
            &RedirectTarget::Loopback { port: 51_789 },
            Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "s-t-a-t-e",
        )
    }

    #[test]
    fn the_authorization_url_carries_everything_google_needs() {
        let url = session().authorization_url();
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=s-t-a-t-e"));
        // Offline access, or the connection dies an hour after it is made.
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        // The scopes are space separated *in* one encoded parameter.
        assert!(url.contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20"));
        // And the verifier is the one thing that must never appear.
        assert!(!url.contains("dBjftJeZ4CVP"));
    }

    #[test]
    fn the_exchange_sends_the_verifier_and_no_secret() {
        let session = session();
        let fields = session.exchange_fields("4/0AX4");
        assert!(fields.contains(&("grant_type", "authorization_code")));
        assert!(fields.contains(&("code", "4/0AX4")));
        assert!(fields.contains(&("code_verifier", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")));
        // A public client has no secret worth shipping; sending one would be
        // security theatre and Google does not want it.
        assert!(!fields.iter().any(|(key, _)| *key == "client_secret"));
        // The redirect must match the one the code was issued against.
        assert!(fields.contains(&("redirect_uri", "http://127.0.0.1:51789/oauth2redirect")));
    }

    #[test]
    fn a_refresh_carries_the_refresh_token_and_nothing_else() {
        let fields = refresh_fields("client", "1//refresh");
        assert_eq!(
            fields,
            vec![
                ("client_id", "client"),
                ("refresh_token", "1//refresh"),
                ("grant_type", "refresh_token"),
            ]
        );
    }

    #[test]
    fn a_redirect_yields_its_code_and_state() {
        let parsed = parse_redirect("http://127.0.0.1:51789/oauth2redirect?state=s-t-a-t-e&code=4%2F0AX4&scope=x").unwrap();
        assert_eq!(parsed.code, "4/0AX4");
        assert_eq!(parsed.state, "s-t-a-t-e");
        // The Android side hands over a custom-scheme URI, and a bare query
        // works too, since the two platforms deliver it differently.
        assert_eq!(
            parse_redirect("com.notex.app:/oauth2redirect?code=abc&state=xyz").unwrap().code,
            "abc"
        );
        assert_eq!(parse_redirect("code=abc&state=xyz").unwrap().state, "xyz");
    }

    #[test]
    fn a_cancelled_sign_in_reads_as_cancelled_rather_than_as_a_failure() {
        // Tapping "Cancel" is not an error to apologise for; it is an answer.
        let error = parse_redirect("?error=access_denied&state=s").unwrap_err();
        assert_eq!(error, "Sign-in was cancelled.");

        let error = parse_redirect("?error=invalid_scope&error_description=Bad%20scope").unwrap_err();
        assert!(error.contains("Bad scope"), "{error}");
        assert!(error.contains("invalid_scope"), "{error}");

        assert!(parse_redirect("?state=only").is_err());
        assert!(parse_redirect("?code=&state=s").is_err());
    }

    #[test]
    fn percent_decoding_survives_a_malformed_escape() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%C3%A9"), "é");
    }

    #[test]
    fn a_token_response_becomes_a_token_set_with_a_real_expiry() {
        let body = br#"{
            "access_token": "ya29.a0Ae",
            "expires_in": 3599,
            "refresh_token": "1//0gRefresh",
            "scope": "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
            "token_type": "Bearer"
        }"#;
        let tokens = parse_token_response(body, 1_000_000, None).unwrap();
        assert_eq!(tokens.access_token, "ya29.a0Ae");
        assert_eq!(tokens.refresh_token, "1//0gRefresh");
        assert_eq!(tokens.expires_at_ms, 1_000_000 + 3_599_000);
        assert!(tokens.has_drive_scope());
    }

    #[test]
    fn a_refresh_keeps_the_refresh_token_it_was_not_sent_again() {
        // Google returns no `refresh_token` when refreshing. Dropping it here
        // would leave an account that works for an hour and then cannot renew,
        // which looks like a random sign-out days later.
        let body = br#"{"access_token":"ya29.new","expires_in":3599,"scope":"https://www.googleapis.com/auth/drive.file","token_type":"Bearer"}"#;
        let tokens = parse_token_response(body, 0, Some("1//0gRefresh")).unwrap();
        assert_eq!(tokens.refresh_token, "1//0gRefresh");
        assert_eq!(tokens.access_token, "ya29.new");
    }

    #[test]
    fn a_token_error_is_reported_with_googles_own_words() {
        let body = br#"{"error":"invalid_grant","error_description":"Bad Request"}"#;
        let error = parse_token_response(body, 0, None).unwrap_err();
        assert!(error.contains("Bad Request"), "{error}");
        assert!(parse_token_response(b"<html>", 0, None).is_err());
        assert!(parse_token_response(br#"{"expires_in":1}"#, 0, None).is_err());
    }

    #[test]
    fn expiry_is_judged_early_by_the_skew() {
        let tokens = TokenSet {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at_ms: 1_000_000,
            scope: DRIVE_FILE_SCOPE.into(),
            account: String::new(),
        };
        assert!(!tokens.needs_refresh(1_000_000 - EXPIRY_SKEW_MS - 1));
        // Exactly one skew out is already treated as expired: a request built
        // now may not be answered for a second or two.
        assert!(tokens.needs_refresh(1_000_000 - EXPIRY_SKEW_MS));
        assert!(tokens.needs_refresh(2_000_000));
        assert!(TokenSet {
            access_token: String::new(),
            ..tokens
        }
        .needs_refresh(0));
    }

    #[test]
    fn a_consent_with_drive_unticked_is_detectable_before_the_first_upload() {
        let body = br#"{"access_token":"ya29","expires_in":3599,"scope":"https://www.googleapis.com/auth/userinfo.email"}"#;
        let tokens = parse_token_response(body, 0, Some("r")).unwrap();
        assert!(!tokens.has_drive_scope());
    }

    #[test]
    fn an_account_email_is_optional() {
        assert_eq!(parse_account_email(br#"{"email":"a@b.com"}"#), Some("a@b.com".to_string()));
        assert_eq!(parse_account_email(br#"{"sub":"1"}"#), None);
        assert_eq!(parse_account_email(b"nope"), None);
    }
}
