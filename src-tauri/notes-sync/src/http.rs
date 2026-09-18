//! The seam between "what request to send" and "how to send it".
//!
//! This crate carries no HTTP client on purpose. A TLS stack is the single
//! heaviest thing that could be added here, it has to cross-compile to four
//! Android ABIs, and none of the interesting logic in a REST client needs one:
//! building a query, shaping a multipart body, reading a status code and
//! parsing a response are all pure functions of bytes. So the shell supplies a
//! transport and everything above it — the whole Google Drive provider, the
//! whole OAuth exchange — is written against this trait and tested against a
//! recording of the real API's answers.
//!
//! The upshot is that a wrong URL, a missing header, a misparsed error
//! envelope or a bad conflict decision fails in `cargo test -p notes-sync` in
//! milliseconds, rather than against Google's servers with an account
//! attached.

use std::fmt;

/// An HTTP request, as data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    /// Header name/value pairs. Names are sent as written.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self::new(Method::Get, url)
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self::new(Method::Post, url)
    }

    pub fn patch(url: impl Into<String>) -> Self {
        Self::new(Method::Patch, url)
    }

    pub fn delete(url: impl Into<String>) -> Self {
        Self::new(Method::Delete, url)
    }

    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    #[must_use]
    pub fn bearer(self, token: &str) -> Self {
        self.header("Authorization", format!("Bearer {token}"))
    }

    #[must_use]
    pub fn body(mut self, content_type: &str, bytes: impl Into<Vec<u8>>) -> Self {
        self.body = Some(bytes.into());
        self.header("Content-Type", content_type)
    }

    /// `application/x-www-form-urlencoded`, which is what both OAuth token
    /// endpoints take.
    #[must_use]
    pub fn form(self, fields: &[(&str, &str)]) -> Self {
        self.body("application/x-www-form-urlencoded", form_encode(fields).into_bytes())
    }
}

/// A response, as data. The body is bytes because a `.notex` download is not
/// text and must not be forced through UTF-8.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// True for the one status worth retrying differently: the token expired
    /// mid-flight, so refreshing and going again is likely to work.
    pub fn is_unauthorized(&self) -> bool {
        self.status == 401
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Result<serde_json::Value, String> {
        serde_json::from_slice(&self.body).map_err(|e| format!("The server sent something that is not JSON: {e}"))
    }
}

/// How bytes actually leave the machine. Implemented by the Tauri shell.
///
/// `Send + Sync` because the sync manager holds a provider behind a lock and
/// drives it from a background thread.
pub trait HttpTransport: Send + Sync {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

/// So a caller can hold `Box<dyn HttpTransport>` and still satisfy the generic
/// bound — which is what lets the shell pick its transport at runtime without
/// every type above it becoming generic over the choice.
impl HttpTransport for Box<dyn HttpTransport> {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        (**self).send(request)
    }
}

/// The transport for a build with no networking compiled in.
///
/// It exists so the cloud code paths still type-check and still *run* in that
/// configuration, failing with a sentence instead of being `#[cfg]`-ed out of
/// existence and rotting. Nothing ships with this; it is what the Tauri
/// shell's Windows type-check builds against, because the real transport
/// drags in a TLS stack whose C build needs a toolchain that cross-check does
/// not have.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableTransport;

impl HttpTransport for UnavailableTransport {
    fn send(&self, _request: HttpRequest) -> Result<HttpResponse, String> {
        Err("This build has no network support, so cloud sync is unavailable.".to_string())
    }
}

/// Percent-encode one value for a query string or a form body.
///
/// Encodes everything outside the unreserved set of RFC 3986, which is
/// stricter than necessary for a query and exactly right for a form body — a
/// PKCE verifier, a file name with a space in it and an OAuth `state` all
/// survive it unchanged in meaning.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn form_encode(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Build `base?key=value&…` with every value encoded.
pub fn query_url(base: &str, params: &[(&str, &str)]) -> String {
    if params.is_empty() {
        return base.to_string();
    }
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}{}", form_encode(params))
}

#[cfg(test)]
pub mod test_support {
    //! A transport that answers from a script instead of a network.
    //!
    //! Every Drive and OAuth test in this crate runs through this: the
    //! requests it recorded are asserted against, and the responses it returns
    //! are the shapes Google's API documents. That is what makes "did we build
    //! the right request" and "do we parse the real answer" testable at all
    //! without an account and a network.
    use std::sync::Mutex;

    use super::*;

    type Responder = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, String> + Send + Sync>;

    #[derive(Default)]
    pub struct MockTransport {
        /// Answers, in the order they will be given.
        queue: Mutex<Vec<Responder>>,
        /// Every request that was sent, in order.
        sent: Mutex<Vec<HttpRequest>>,
    }

    impl MockTransport {
        pub fn new() -> Self {
            Self::default()
        }

        /// Queue one canned response.
        pub fn reply(&self, status: u16, body: impl Into<Vec<u8>>) -> &Self {
            let body = body.into();
            self.queue
                .lock()
                .unwrap()
                .push(Box::new(move |_| Ok(HttpResponse::new(status, body.clone()))));
            self
        }

        pub fn reply_json(&self, status: u16, body: &str) -> &Self {
            self.reply(status, body.as_bytes().to_vec())
        }

        /// Queue an answer that depends on the request, for asserting inside
        /// the exchange rather than after it.
        pub fn reply_with(&self, responder: impl Fn(&HttpRequest) -> Result<HttpResponse, String> + Send + Sync + 'static) -> &Self {
            self.queue.lock().unwrap().push(Box::new(responder));
            self
        }

        /// Queue a transport-level failure (no network, DNS, TLS).
        pub fn fail(&self, message: &str) -> &Self {
            let message = message.to_string();
            self.queue.lock().unwrap().push(Box::new(move |_| Err(message.clone())));
            self
        }

        pub fn requests(&self) -> Vec<HttpRequest> {
            self.sent.lock().unwrap().clone()
        }

        pub fn request(&self, index: usize) -> HttpRequest {
            self.requests()
                .get(index)
                .cloned()
                .unwrap_or_else(|| panic!("no request was sent at index {index}"))
        }

        pub fn request_count(&self) -> usize {
            self.sent.lock().unwrap().len()
        }

        /// Nothing left unused: a queued response that was never asked for
        /// usually means a round trip was skipped by mistake.
        pub fn assert_drained(&self) {
            let left = self.queue.lock().unwrap().len();
            assert_eq!(left, 0, "{left} queued response(s) were never requested");
        }
    }

    impl HttpTransport for MockTransport {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
            self.sent.lock().unwrap().push(request.clone());
            let mut queue = self.queue.lock().unwrap();
            if queue.is_empty() {
                return Err(format!("MockTransport has no answer for {} {}", request.method, request.url));
            }
            let responder = queue.remove(0);
            drop(queue);
            responder(&request)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{test_support::MockTransport, *};

    #[test]
    fn unreserved_characters_survive_encoding_and_everything_else_does_not() {
        // The PKCE verifier alphabet is exactly the unreserved set, so a
        // verifier must come back byte for byte or the exchange fails with a
        // mismatch that is very hard to read from Google's error.
        assert_eq!(percent_encode("aZ09-._~"), "aZ09-._~");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a/b"), "a%2Fb");
        assert_eq!(percent_encode("&="), "%26%3D");
        assert_eq!(percent_encode("é"), "%C3%A9");
    }

    #[test]
    fn a_form_body_encodes_both_halves_of_every_pair() {
        assert_eq!(
            form_encode(&[("grant_type", "authorization_code"), ("code", "4/0Ab c")]),
            "grant_type=authorization_code&code=4%2F0Ab%20c"
        );
        assert_eq!(form_encode(&[]), "");
    }

    #[test]
    fn a_query_url_picks_the_right_separator() {
        assert_eq!(query_url("https://x/y", &[("a", "1")]), "https://x/y?a=1");
        assert_eq!(query_url("https://x/y?z=0", &[("a", "1")]), "https://x/y?z=0&a=1");
        assert_eq!(query_url("https://x/y", &[]), "https://x/y");
    }

    #[test]
    fn a_drive_query_with_quotes_and_spaces_round_trips() {
        // Drive's `q` parameter is a little language of its own, full of
        // quotes, braces and spaces. If it is not encoded the request is not
        // merely wrong, it is a different query.
        let url = query_url(
            "https://www.googleapis.com/drive/v3/files",
            &[("q", "name = 'Notex Sync' and trashed = false")],
        );
        assert_eq!(
            url,
            "https://www.googleapis.com/drive/v3/files?q=name%20%3D%20%27Notex%20Sync%27%20and%20trashed%20%3D%20false"
        );
    }

    #[test]
    fn responses_classify_success_and_expiry() {
        assert!(HttpResponse::new(200, "").is_success());
        assert!(HttpResponse::new(204, "").is_success());
        assert!(!HttpResponse::new(302, "").is_success());
        assert!(!HttpResponse::new(401, "").is_success());
        assert!(HttpResponse::new(401, "").is_unauthorized());
        assert!(!HttpResponse::new(403, "").is_unauthorized());
    }

    #[test]
    fn a_body_that_is_not_json_is_reported_rather_than_panicking() {
        // Google's load balancers answer with HTML when something upstream is
        // wrong, and a client that unwraps here dies on a bad day.
        let response = HttpResponse::new(502, "<html>Bad Gateway</html>");
        assert!(response.json().is_err());
        assert_eq!(response.text(), "<html>Bad Gateway</html>");
    }

    #[test]
    fn the_mock_transport_records_requests_and_answers_in_order() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"first":true}"#).reply_json(404, r#"{"second":true}"#);

        let one = transport.send(HttpRequest::get("https://x/1")).unwrap();
        let two = transport.send(HttpRequest::post("https://x/2").form(&[("a", "b")])).unwrap();

        assert_eq!(one.json().unwrap()["first"], serde_json::json!(true));
        assert_eq!(two.status, 404);
        assert_eq!(transport.request_count(), 2);
        assert_eq!(transport.request(1).method, Method::Post);
        assert_eq!(transport.request(1).body.unwrap(), b"a=b".to_vec());
        transport.assert_drained();
    }

    #[test]
    fn a_boxed_transport_is_still_a_transport() {
        let transport = MockTransport::new();
        transport.reply_json(200, r#"{"ok":true}"#);
        let boxed: Box<dyn HttpTransport> = Box::new(transport);
        assert!(boxed.send(HttpRequest::get("https://x")).unwrap().is_success());
    }

    #[test]
    fn the_unavailable_transport_says_so_rather_than_hanging() {
        let error = UnavailableTransport.send(HttpRequest::get("https://x")).unwrap_err();
        assert!(error.contains("cloud sync is unavailable"), "{error}");
    }

    #[test]
    fn a_transport_failure_is_an_error_not_a_status() {
        let transport = MockTransport::new();
        transport.fail("dns error: no such host");
        assert!(transport.send(HttpRequest::get("https://x")).is_err());
    }
}
