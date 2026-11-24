//! What went wrong natively, kept for the next start.
//!
//! The app on Windows was reported closing a few seconds or a minute into writing with the pen, with
//! nothing to say why: the record the page keeps (`lib/problemLog.ts`) only sees errors in the page's
//! own code, and what closes a window is a step below it — the web view's page process dying, or a
//! native error, which with `panic = "abort"` took the whole app down on the spot. So two things are
//! written down here, to a small file in the app's data folder, and handed to the page at its next
//! start for the problem report:
//!
//! - a native error (a Rust panic): where it was and what it said;
//! - the web view losing one of its processes (WebView2's `ProcessFailed`): which one, why (crashed,
//!   out of memory, unresponsive) and its exit code. When it was the page's own process, the page is
//!   loaded again rather than leaving a dead window: the draft brings the writing back.
//!
//! Nothing here leaves the device; the page shows it only when asked to copy the report.

use notes_sync::problems;

/// Start keeping the record in `dir` (`notes_sync::problems`), with native errors caught into it.
pub fn install(dir: std::path::PathBuf) {
    problems::install(&dir);
}

/// The record so far, for the page's problem report; read once, then started afresh.
#[tauri::command]
pub fn take_native_problems() -> Result<String, String> {
    problems::take()
}

/// Watch the main window's web view for a process it loses (Windows: WebView2's `ProcessFailed`).
#[cfg(windows)]
pub fn watch_webview(app: &tauri::AppHandle) {
    use std::time::{Duration, Instant};
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows::core::Interface;

    /// A restart of the whole app only for one that had been running a while: never a loop of them.
    const RESTART_AFTER: Duration = Duration::from_secs(30);

    let Some(window) = app.get_webview_window("main") else { return };
    let started = Instant::now();
    let handle = app.clone();
    let _ = window.with_webview(move |webview| {
        // SAFETY: `with_webview` runs this on the thread that owns the web view, where WebView2 is
        // called; the handler is kept alive by the web view, which owns the registration.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let mut token = 0i64;
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                let mut exit_code = 0i32;
                if let Ok(more) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let _ = more.Reason(&mut reason);
                    let _ = more.ExitCode(&mut exit_code);
                }
                problems::record(
                    "The web view lost a process",
                    &format!("{} ({}), exit code {exit_code:#x}", problems::webview_process_name(kind.0), problems::webview_reason_name(reason.0)),
                );
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    // The page is gone, and with it nothing that was not already in the draft: load it again.
                    if let Some(core) = sender {
                        let _ = core.Reload();
                    }
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED && started.elapsed() > RESTART_AFTER {
                    // The whole web view is gone: the window cannot show anything again. Start the app afresh.
                    handle.request_restart();
                }
                Ok(())
            }));
            let _ = core.add_ProcessFailed(&handler, &mut token);
        }
    });
}

#[cfg(not(windows))]
pub fn watch_webview(_app: &tauri::AppHandle) {}
