//! The real HTTPS transport for [`notes_sync::HttpTransport`].
//!
//! Small on purpose. Everything that can be decided — which URL, which
//! headers, what the answer means — lives in `notes-sync` where it is tested
//! against recorded Google responses. What is left here is the part that can
//! only be checked by actually sending bytes: opening a TLS connection,
//! copying a body in and out, and turning ureq's two kinds of failure into the
//! one kind the trait describes.
//!
//! The important translation is that **an HTTP error status is not a transport
//! error**. ureq reports a 401 or a 403 as `Err(Error::Status(..))`, but to
//! everything above this it is an ordinary answer that carries meaning: a 401
//! triggers a token refresh, a 403 about quota gets its own message, a 404 on
//! a delete means the file was already gone. Only a connection that never
//! produced a response — DNS, TLS, a timeout — is an `Err` here.

use std::{io::Read, time::Duration};

use notes_sync::http::{HttpRequest, HttpResponse, HttpTransport, Method};

/// Long enough for a slow mobile connection to upload a notebook, short enough
/// that a sync pass cannot park a thread for the afternoon.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// A `.notex` file with imported PDF pages is the large case; past this
/// something has gone wrong and reading it all into memory would be the
/// second mistake.
pub const MAX_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;

pub struct UreqTransport {
    agent: ureq::Agent,
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl UreqTransport {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(15))
                .timeout(TIMEOUT)
                // Google redirects `www.googleapis.com` occasionally; following
                // a couple is normal, following a chain is a loop.
                .redirects(5)
                .user_agent(concat!("Notex/", env!("CARGO_PKG_VERSION")))
                .build(),
        }
    }
}

impl HttpTransport for UreqTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let mut call = self.agent.request(request.method.as_str(), &request.url);
        for (name, value) in &request.headers {
            call = call.set(name, value);
        }

        let result = match (&request.body, request.method) {
            (Some(bytes), _) => call.send_bytes(bytes),
            // A GET with an empty body, rather than a zero-length one: some
            // proxies treat `Content-Length: 0` on a GET as malformed.
            (None, Method::Get | Method::Delete) => call.call(),
            (None, _) => call.send_bytes(&[]),
        };

        let response = match result {
            Ok(response) => response,
            // The status *is* the answer; only a failure to get one is an error.
            Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(transport)) => return Err(describe(&transport)),
        };

        let status = response.status();
        let mut body = Vec::new();
        response
            .into_reader()
            .take(MAX_RESPONSE_BYTES)
            .read_to_end(&mut body)
            .map_err(|e| format!("The connection dropped while reading the reply: {e}"))?;
        Ok(HttpResponse { status, body })
    }
}

/// Say what went wrong in words someone can act on.
///
/// ureq's own message names the host and the cause, which is useful, but on
/// its own it reads like a stack trace. The common cases are worth naming,
/// because "you are offline" and "your clock is wrong" have completely
/// different answers and both surface as a TLS failure.
fn describe(error: &ureq::Transport) -> String {
    let detail = error.to_string();
    let lowered = detail.to_lowercase();
    if lowered.contains("dns") || lowered.contains("resolve") {
        return format!("Cannot reach Google — this device looks offline. ({detail})");
    }
    if lowered.contains("timed out") || lowered.contains("timeout") {
        return format!("Google did not answer in time. ({detail})");
    }
    if lowered.contains("certificate") || lowered.contains("tls") || lowered.contains("handshake") {
        // An expired certificate here is almost always a clock that is wrong,
        // which is invisible until something checks a certificate.
        return format!("The secure connection to Google failed — check this device's date and time. ({detail})");
    }
    format!("The connection to Google failed: {detail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::{Ipv4Addr, TcpListener},
        thread,
    };

    /// A one-request HTTP server, so the transport can be exercised over a
    /// real socket. Plain HTTP rather than TLS: what is being tested is the
    /// request/response translation, and rustls is not this crate's to verify.
    fn serve(response: &'static str) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Read just the headers, then whatever body was announced.
            let mut seen = Vec::new();
            let mut byte = [0_u8; 1];
            while !seen.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                seen.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&seen).into_owned();
            let length: usize = head
                .lines()
                .find_map(|line| line.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string()))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let mut body = vec![0_u8; length];
            if length > 0 {
                stream.read_exact(&mut body).unwrap();
            }
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            format!("{head}{}", String::from_utf8_lossy(&body))
        });
        (port, handle)
    }

    #[test]
    fn it_sends_the_method_headers_and_body_it_was_given() {
        let (port, server) = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
        let transport = UreqTransport::new();
        let response = transport
            .send(
                HttpRequest::patch(format!("http://127.0.0.1:{port}/drive/v3/files/abc"))
                    .bearer("ya29.token")
                    .body("application/json", b"{\"trashed\":true}".to_vec()),
            )
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"hi");

        let sent = server.join().unwrap();
        assert!(sent.starts_with("PATCH /drive/v3/files/abc HTTP/1.1"), "{sent}");
        assert!(sent.contains("Authorization: Bearer ya29.token"), "{sent}");
        assert!(sent.contains("Content-Type: application/json"), "{sent}");
        assert!(sent.ends_with("{\"trashed\":true}"), "{sent}");
    }

    #[test]
    fn an_error_status_is_an_answer_not_a_failure() {
        // The whole reason this file exists. ureq raises a 401 as an `Err`;
        // above here a 401 means "refresh the token and try again", and a
        // transport that turned it into an error would make that impossible.
        let (port, server) = serve(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 42\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"Invalid Credentials\"}}",
        );
        let response = UreqTransport::new()
            .send(HttpRequest::get(format!("http://127.0.0.1:{port}/x")))
            .expect("a 401 must come back as a response");
        assert_eq!(response.status, 401);
        assert!(response.is_unauthorized());
        assert!(response.text().contains("Invalid Credentials"));
        server.join().unwrap();
    }

    #[test]
    fn a_binary_body_survives_the_round_trip() {
        // A `.notex` download is not text, and anything that forces it through
        // UTF-8 corrupts it silently.
        let (port, server) = serve("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\u{0}\u{1}\u{2}\u{3}");
        let response = UreqTransport::new()
            .send(HttpRequest::get(format!("http://127.0.0.1:{port}/x")))
            .unwrap();
        assert_eq!(response.body, vec![0, 1, 2, 3]);
        server.join().unwrap();
    }

    #[test]
    fn a_get_carries_no_content_length() {
        let (port, server) = serve("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        UreqTransport::new()
            .send(HttpRequest::get(format!("http://127.0.0.1:{port}/x")))
            .unwrap();
        let sent = server.join().unwrap();
        assert!(!sent.to_lowercase().contains("content-length"), "{sent}");
    }

    #[test]
    fn a_connection_that_never_answers_is_an_error_worth_reading() {
        // Port 1 on loopback with nothing behind it: refused immediately, so
        // this stays fast and does not depend on the network being absent.
        let error = UreqTransport::new()
            .send(HttpRequest::get("http://127.0.0.1:1/x"))
            .unwrap_err();
        assert!(error.contains("connection to Google failed") || error.contains("offline"), "{error}");
    }

    #[test]
    fn an_unresolvable_host_says_the_device_looks_offline() {
        let error = UreqTransport::new()
            .send(HttpRequest::get("http://notex-does-not-exist.invalid/x"))
            .unwrap_err();
        assert!(error.contains("offline"), "{error}");
    }
}
