//! The desktop half of the OAuth redirect: a one-shot web server on 127.0.0.1.
//!
//! A desktop app has no URL for Google to redirect to, so RFC 8252 §7.3 says
//! to become one for a moment: bind an ephemeral port on the loopback
//! interface, hand Google `http://127.0.0.1:<port>/oauth2redirect` as the
//! redirect, and read the authorization code out of the request the browser
//! makes on its way back. The listener closes as soon as it has the answer, so
//! the port is open for the length of one sign-in and not a second longer.
//!
//! Three things here are load-bearing rather than incidental:
//!
//! - **Port 0.** The kernel picks a free port, so two instances cannot fight
//!   over a hard-coded one and nothing needs a firewall exception for a
//!   well-known number.
//! - **A reply the user can read.** The browser is showing this tab; leaving
//!   it on a connection error would make a sign-in that worked look broken.
//! - **A deadline.** Someone who closes the consent screen never comes back,
//!   and a thread parked on `accept()` forever is a leak that outlives the
//!   window.
//!
//! It is in this crate rather than the Tauri shell because it is plain `std`
//! with no webview anywhere near it — which means it can be tested by actually
//! connecting a socket to it, rather than by hoping.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    time::{Duration, Instant},
};

use crate::oauth::{parse_redirect, AuthCode};

/// How long to wait for the browser to come back before giving up.
pub const REDIRECT_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a single connection may take to send its request line. Short: this
/// is a browser on the same machine, and the only thing that dawdles here is
/// something that is not a browser.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Cap on the request line, so a client that never sends a newline cannot make
/// this allocate without bound.
const MAX_REQUEST_LINE: u64 = 8 * 1024;

/// A bound loopback listener waiting for exactly one redirect.
pub struct RedirectListener {
    listener: TcpListener,
    port: u16,
}

impl RedirectListener {
    /// Bind an ephemeral port on the loopback interface.
    ///
    /// `127.0.0.1`, never `0.0.0.0`: this must not be reachable from the
    /// network, and on Windows binding a wildcard address is also what
    /// triggers the firewall prompt.
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Wait for the redirect and return the code it carries.
    ///
    /// Keeps listening through requests that are not the redirect — a browser
    /// will cheerfully ask for `/favicon.ico` on the same port, and treating
    /// that as the answer would fail the sign-in for no reason.
    pub fn wait(&self, expected_state: &str) -> Result<AuthCode, String> {
        self.wait_until(expected_state, Instant::now() + REDIRECT_TIMEOUT)
    }

    pub fn wait_until(&self, expected_state: &str, deadline: Instant) -> Result<AuthCode, String> {
        self.listener
            .set_nonblocking(false)
            .map_err(|e| format!("Cannot wait for the sign-in: {e}"))?;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("The sign-in was not completed in time.".to_string());
            }

            let (stream, _) = self
                .listener
                .accept()
                .map_err(|e| format!("The sign-in listener stopped: {e}"))?;

            match handle(stream, expected_state) {
                Outcome::Answered(result) => return result,
                Outcome::NotTheRedirect => continue,
            }
        }
    }
}

enum Outcome {
    /// This connection was the redirect (or an unmistakable failure of it).
    Answered(Result<AuthCode, String>),
    /// Something else knocked; keep waiting.
    NotTheRedirect,
}

fn handle(mut stream: TcpStream, expected_state: &str) -> Outcome {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));

    let target = match read_request_target(&stream) {
        Some(target) => target,
        None => {
            respond(&mut stream, 400, "Bad request", "That was not a sign-in redirect.");
            return Outcome::NotTheRedirect;
        }
    };

    if !target.starts_with("/oauth2redirect") {
        // Favicons, a stray refresh, a port scanner. Not an error.
        respond(&mut stream, 404, "Not found", "Nothing to see here.");
        return Outcome::NotTheRedirect;
    }

    let result = parse_redirect(&target).and_then(|auth| {
        // The state check is the CSRF defence: without it, anything that can
        // reach this port could feed the app an authorization code belonging
        // to an account the user never chose.
        if auth.state == expected_state {
            Ok(auth)
        } else {
            Err("That redirect did not belong to this sign-in.".to_string())
        }
    });

    match &result {
        Ok(_) => respond(
            &mut stream,
            200,
            "Signed in",
            "You are signed in to Google Drive. You can close this tab and go back to Notex.",
        ),
        Err(message) => respond(&mut stream, 400, "Sign-in failed", message),
    }
    Outcome::Answered(result)
}

/// Read the path out of `GET /oauth2redirect?... HTTP/1.1`.
fn read_request_target(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.take(MAX_REQUEST_LINE));
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    // A browser following a redirect always uses GET; anything else is not it.
    if method != "GET" {
        return None;
    }
    Some(target.to_string())
}

/// Answer with a small self-contained page.
///
/// No external stylesheet or script: this is served once, over plain HTTP, by
/// an app that is about to stop listening. It only has to be legible.
fn respond(stream: &mut TcpStream, status: u16, title: &str, message: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;\
         background:#f4f4f5;color:#18181b\">\
         <main style=\"max-width:32rem;padding:2rem;text-align:center\">\
         <h1 style=\"font-size:1.25rem;margin:0 0 .5rem\">{title}</h1>\
         <p style=\"margin:0;color:#52525b\">{message}</p></main></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    /// Talk to the listener the way a browser would, and return its reply.
    fn request(port: u16, line: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        stream
            .write_all(format!("{line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes())
            .expect("write");
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }

    #[test]
    fn it_binds_an_ephemeral_loopback_port() {
        let listener = RedirectListener::bind().unwrap();
        assert!(listener.port() > 0);
        // Reachable from this machine…
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, listener.port())).is_ok());
        // …and two of them never collide, which a fixed port could not promise.
        let other = RedirectListener::bind().unwrap();
        assert_ne!(listener.port(), other.port());
    }

    #[test]
    fn it_reads_the_code_out_of_a_real_http_request() {
        let listener = RedirectListener::bind().unwrap();
        let port = listener.port();
        let handle = thread::spawn(move || listener.wait_until("st4te", Instant::now() + Duration::from_secs(10)));

        let reply = request(port, "GET /oauth2redirect?state=st4te&code=4%2F0AX4 HTTP/1.1");

        let auth = handle.join().unwrap().unwrap();
        assert_eq!(auth.code, "4/0AX4");
        assert_eq!(auth.state, "st4te");
        // The browser is looking at this tab, so it gets a page rather than a
        // dead connection.
        assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
        assert!(reply.contains("You are signed in"), "{reply}");
        assert!(reply.contains("Content-Length:"), "{reply}");
    }

    #[test]
    fn a_favicon_request_does_not_end_the_wait() {
        // Browsers ask for /favicon.ico unprompted. Answering that as if it
        // were the redirect would fail a sign-in that is going perfectly well.
        let listener = RedirectListener::bind().unwrap();
        let port = listener.port();
        let handle = thread::spawn(move || listener.wait_until("st4te", Instant::now() + Duration::from_secs(10)));

        let ignored = request(port, "GET /favicon.ico HTTP/1.1");
        assert!(ignored.starts_with("HTTP/1.1 404"), "{ignored}");
        let real = request(port, "GET /oauth2redirect?code=abc&state=st4te HTTP/1.1");
        assert!(real.starts_with("HTTP/1.1 200"), "{real}");

        assert_eq!(handle.join().unwrap().unwrap().code, "abc");
    }

    #[test]
    fn a_redirect_with_the_wrong_state_is_refused() {
        // The CSRF check. Anything on this machine can connect to a loopback
        // port; only the browser Google redirected knows the state.
        let listener = RedirectListener::bind().unwrap();
        let port = listener.port();
        let handle = thread::spawn(move || listener.wait_until("st4te", Instant::now() + Duration::from_secs(10)));

        let reply = request(port, "GET /oauth2redirect?code=abc&state=someone-elses HTTP/1.1");
        assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");

        let error = handle.join().unwrap().unwrap_err();
        assert!(error.contains("did not belong to this sign-in"), "{error}");
    }

    #[test]
    fn a_cancelled_consent_comes_back_as_a_cancellation() {
        let listener = RedirectListener::bind().unwrap();
        let port = listener.port();
        let handle = thread::spawn(move || listener.wait_until("st4te", Instant::now() + Duration::from_secs(10)));

        request(port, "GET /oauth2redirect?error=access_denied&state=st4te HTTP/1.1");

        assert_eq!(handle.join().unwrap().unwrap_err(), "Sign-in was cancelled.");
    }

    #[test]
    fn a_deadline_that_has_passed_gives_up_instead_of_waiting_forever() {
        // Someone who closes the consent tab never comes back, and a thread
        // parked on accept() would outlive the window that started it.
        let listener = RedirectListener::bind().unwrap();
        let error = listener
            .wait_until("st4te", Instant::now() - Duration::from_secs(1))
            .unwrap_err();
        assert!(error.contains("not completed in time"), "{error}");
    }

    #[test]
    fn a_client_that_is_not_a_browser_does_not_end_the_wait() {
        let listener = RedirectListener::bind().unwrap();
        let port = listener.port();
        let handle = thread::spawn(move || listener.wait_until("st4te", Instant::now() + Duration::from_secs(10)));

        // A POST, and a connection that says nothing at all: neither is the
        // redirect, and neither may be allowed to fail the sign-in.
        request(port, "POST /oauth2redirect?code=abc&state=st4te HTTP/1.1");
        drop(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap());

        let real = request(port, "GET /oauth2redirect?code=good&state=st4te HTTP/1.1");
        assert!(real.starts_with("HTTP/1.1 200"), "{real}");
        assert_eq!(handle.join().unwrap().unwrap().code, "good");
    }

    #[test]
    fn the_redirect_uri_matches_the_port_that_was_bound() {
        // These two must agree exactly or Google refuses the exchange with
        // `redirect_uri_mismatch`, which says nothing about the port.
        let listener = RedirectListener::bind().unwrap();
        let target = crate::oauth::RedirectTarget::Loopback {
            port: listener.port(),
        };
        assert_eq!(target.uri(), format!("http://127.0.0.1:{}/oauth2redirect", listener.port()));
    }
}
