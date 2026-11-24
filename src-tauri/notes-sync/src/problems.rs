//! What went wrong natively, kept for the next start (see the app's `crash_log.rs` for why).
//!
//! A small file in the app's data folder, one line per problem: when, what, and the detail. The app
//! hands it to the page at its next start for the problem report, and starts it afresh. Nothing here
//! leaves the device.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: OnceLock<PathBuf> = OnceLock::new();

/// The file is kept small: past this it starts again.
const MAX_BYTES: u64 = 64 * 1024;
pub const FILE_NAME: &str = "native-problems.log";

/// Start keeping the record in `dir`, and catch every native error into it (before it ends the app,
/// or the command it happened in).
pub fn install(dir: &Path) {
    let _ = LOG.set(dir.join(FILE_NAME));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".to_string());
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        record("A native error", &format!("{message} at {place}, on the {thread} thread"));
        previous(info);
    }));
}

/// Write one line down: when, what, and the detail.
pub fn record(what: &str, detail: &str) {
    if let Some(path) = LOG.get() {
        record_to(path, what, detail);
    }
}

fn record_to(path: &Path, what: &str, detail: &str) {
    if fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::remove_file(path);
    }
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return };
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(file, "{seconds}\t{what}\t{}", detail.replace(['\n', '\r', '\t'], " "));
}

/// The record so far; read once, then started afresh.
pub fn take() -> Result<String, String> {
    match LOG.get() {
        Some(path) => take_from(path),
        None => Ok(String::new()),
    }
}

fn take_from(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let _ = fs::remove_file(path);
            Ok(text)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Cannot read {}: {e}", path.display())),
    }
}

/// WebView2's process kinds (`COREWEBVIEW2_PROCESS_FAILED_KIND`), by number, as its documentation names them.
pub fn webview_process_name(kind: i32) -> &'static str {
    match kind {
        0 => "the browser process exited",
        1 => "the page's process exited",
        2 => "the page stopped responding",
        3 => "a frame's process exited",
        4 => "a utility process exited",
        5 => "the sandbox helper exited",
        6 => "the graphics (GPU) process exited",
        7 => "a plug-in process exited",
        8 => "a plug-in broker exited",
        _ => "an unknown process exited",
    }
}

/// WebView2's reasons (`COREWEBVIEW2_PROCESS_FAILED_REASON`), by number.
pub fn webview_reason_name(reason: i32) -> &'static str {
    match reason {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "failed to launch",
        5 => "out of memory",
        6 => "profile deleted",
        _ => "no reason given",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_what_the_web_view_reports() {
        assert_eq!(webview_process_name(1), "the page's process exited");
        assert_eq!(webview_process_name(6), "the graphics (GPU) process exited");
        assert_eq!(webview_reason_name(5), "out of memory");
        assert_eq!(webview_reason_name(42), "no reason given");
    }

    #[test]
    fn keeps_a_line_a_problem_and_hands_them_over_once() {
        let dir = std::env::temp_dir().join(format!("kk-problems-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(FILE_NAME);
        record_to(&path, "A native error", "boom\tat here\nnext");
        record_to(&path, "The web view lost a process", "the page's process exited (crashed)");
        let text = take_from(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].ends_with("\tA native error\tboom at here next"), "{text}");
        assert_eq!(take_from(&path).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn starts_again_rather_than_growing_without_end() {
        let dir = std::env::temp_dir().join(format!("kk-problems-big-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(FILE_NAME);
        let long = "x".repeat(1000);
        for _ in 0..100 {
            record_to(&path, "A native error", &long);
        }
        assert!(fs::metadata(&path).unwrap().len() <= MAX_BYTES + 2048);
        let _ = fs::remove_dir_all(&dir);
    }
}
