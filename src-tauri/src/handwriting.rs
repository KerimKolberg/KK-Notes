//! Reading handwriting, so it can be searched.
//!
//! On Windows this is the system's own recogniser — the one behind the pen
//! input panel — reached through WinRT's `InkRecognizerContainer`. It runs on
//! the device, needs no account and sends nothing anywhere, and it reads in
//! whatever languages have handwriting installed (Settings → Time & language →
//! Language & region → a language's options → Handwriting). The strokes are
//! rebuilt as WinRT ink from the points the frontend sends, read as a whole
//! page, and handed back one word at a time with the box it sits in.
//!
//! Other platforms have no such recogniser here: they list none, and asking
//! one to read is an error with a sentence in it. The words a Windows PC read
//! are saved with the note, so those devices still find them.
//!
//! **Kept apart from the app.** The recogniser is Windows' own code, loaded
//! into whatever process asks it to read. The app on Windows was reported
//! closing outright — the window simply gone — a moment after small letters
//! were written, which is when a page is read (1.5 s after the pen leaves);
//! a fault in code loaded into the app takes the whole app with it and leaves
//! no word. So the app does not load it any more: it starts itself again as a
//! small helper with no window (`HELPER_ARG`), hands it the strokes on its
//! input and reads the words from its output. If the recogniser fails, the
//! helper goes and the app does not; that is written down (`crash_log.rs`) as
//! what failed and how, and the page gives up reading after a few failures.

use serde::{Deserialize, Serialize};

/// One stroke as the frontend sends it: x, y, pressure, x, y, pressure, …
#[derive(Debug, Deserialize, Serialize)]
pub struct InkStrokeInput {
    pub points: Vec<f32>,
}

/// One word read, and where it is in the page's units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// The recognisers installed, by name ("Microsoft English (US) Handwriting Recognizer", …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recognizers {
    pub names: Vec<String>,
}

/// Most strokes read at once: far more than a page holds, so a request that big is a mistake, not a page.
const MAX_STROKES: usize = 20_000;

/// The argument that starts the app as the handwriting helper instead (see the module's doc).
pub const HELPER_ARG: &str = "--kk-handwriting-helper";

/// What the app asks the helper, on its input.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "ask", rename_all = "camelCase")]
pub enum HelperRequest {
    Recognizers,
    Recognize { strokes: Vec<InkStrokeInput>, recognizer: Option<String> },
}

/// What the helper answers, on its output.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperReply<T> {
    pub ok: Option<T>,
    pub error: Option<String>,
}

impl<T> HelperReply<T> {
    fn of(result: Result<T, String>) -> Self {
        match result {
            Ok(value) => Self { ok: Some(value), error: None },
            Err(error) => Self { ok: None, error: Some(error) },
        }
    }

    fn into_result(self) -> Result<T, String> {
        match (self.ok, self.error) {
            (Some(value), _) => Ok(value),
            (None, Some(error)) => Err(error),
            (None, None) => Err("The handwriting reader answered with nothing.".to_string()),
        }
    }
}

/// The helper itself: one request on its input, one answer on its output, and gone.
pub fn run_helper() {
    use std::io::{Read, Write};
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let reply = match serde_json::from_str::<HelperRequest>(&input) {
        Ok(HelperRequest::Recognizers) => serde_json::to_string(&HelperReply::of(platform::recognizers())),
        Ok(HelperRequest::Recognize { strokes, recognizer }) => {
            serde_json::to_string(&HelperReply::of(platform::recognize(&strokes, recognizer.as_deref())))
        }
        Err(e) => serde_json::to_string(&HelperReply::<()>::of(Err(format!("The handwriting reader was asked something it does not know: {e}")))),
    };
    if let Ok(reply) = reply {
        let mut out = std::io::stdout();
        let _ = out.write_all(reply.as_bytes());
        let _ = out.flush();
    }
}

/// The recognisers this device has; none where there is no recogniser.
#[tauri::command]
pub async fn ink_recognizers() -> Result<Recognizers, String> {
    tauri::async_runtime::spawn_blocking(|| ask_helper::<Recognizers>(&HelperRequest::Recognizers))
        .await
        .map_err(|e| format!("Could not ask for the handwriting recognisers: {e}"))?
}

/// Read a page's handwriting, with `recognizer` (a name from `ink_recognizers`) or the system's default.
#[tauri::command]
pub async fn recognize_ink(strokes: Vec<InkStrokeInput>, recognizer: Option<String>) -> Result<Vec<RecognizedWord>, String> {
    if strokes.len() > MAX_STROKES {
        return Err(format!("{} strokes is more than one page can hold.", strokes.len()));
    }
    tauri::async_runtime::spawn_blocking(move || ask_helper::<Vec<RecognizedWord>>(&HelperRequest::Recognize { strokes, recognizer }))
        .await
        .map_err(|e| format!("Could not read the handwriting: {e}"))?
}

/// The longest a page's reading may take before the helper is stopped.
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Ask the helper (on Windows; elsewhere there is no recogniser to keep apart, and it is asked here).
#[cfg(windows)]
fn ask_helper<T: serde::de::DeserializeOwned>(request: &HelperRequest) -> Result<T, String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    /// No console window flashes up for it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = std::env::current_exe().map_err(|e| format!("Could not start the handwriting reader: {e}"))?;
    let body = serde_json::to_vec(request).map_err(|e| format!("Could not ask the handwriting reader: {e}"))?;
    let mut child = Command::new(exe)
        .arg(HELPER_ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not start the handwriting reader: {e}"))?;
    // Read what it says as it says it, so a long answer never fills the pipe and stops it.
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let stdout = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(&body);
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > HELPER_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => break None,
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    let Some(status) = status else {
        crate::crash_log::record("The handwriting reader stopped answering", "stopped after 30 s");
        return Err("Windows' handwriting reader stopped answering.".to_string());
    };
    if !status.success() || out.trim().is_empty() {
        let code = status.code().map(|c| format!("{:#x}", c as u32)).unwrap_or_else(|| "none".to_string());
        let said: String = err.trim().chars().take(400).collect();
        crate::crash_log::record("The handwriting reader failed (kept apart from the app)", &format!("exit code {code}; {said}"));
        return Err(format!("Windows' handwriting reader failed (exit code {code}). The app was not affected."));
    }
    serde_json::from_str::<HelperReply<T>>(&out)
        .map_err(|e| format!("The handwriting reader's answer could not be read: {e}"))?
        .into_result()
}

#[cfg(not(windows))]
fn ask_helper<T: serde::de::DeserializeOwned>(request: &HelperRequest) -> Result<T, String> {
    // No recogniser here to keep apart: the request is answered as the helper would, and passed through the same
    // reply, so this path is the one the tests drive.
    let reply = match request {
        HelperRequest::Recognizers => serde_json::to_string(&HelperReply::of(platform::recognizers())),
        HelperRequest::Recognize { strokes, recognizer } => serde_json::to_string(&HelperReply::of(platform::recognize(strokes, recognizer.as_deref()))),
    }
    .map_err(|e| e.to_string())?;
    serde_json::from_str::<HelperReply<T>>(&reply).map_err(|e| e.to_string())?.into_result()
}

/// The points of a stroke as (x, y, pressure), unusable values dropped and pressure kept in (0, 1].
fn points_of(stroke: &InkStrokeInput) -> Vec<(f32, f32, f32)> {
    stroke
        .points
        .chunks_exact(3)
        .filter(|c| c[0].is_finite() && c[1].is_finite())
        .map(|c| (c[0], c[1], if c[2].is_finite() { c[2].clamp(0.01, 1.0) } else { 0.5 }))
        .collect()
}

#[cfg(windows)]
mod platform {
    use super::{points_of, InkStrokeInput, RecognizedWord, Recognizers};
    use windows::core::HSTRING;
    use windows::Foundation::Point;
    use windows::UI::Input::Inking::{
        InkPoint, InkRecognitionTarget, InkRecognizer, InkRecognizerContainer, InkStrokeBuilder, InkStrokeContainer,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows_collections::IIterable;
    use windows_numerics::Matrix3x2;

    fn sentence(what: &str, error: windows::core::Error) -> String {
        format!("{what}: {} (0x{:08X})", error.message(), error.code().0)
    }

    /// The thread pool's threads are not set up for COM; WinRT wants them in the multithreaded apartment.
    /// Asking twice is harmless, and a thread already in another apartment keeps it.
    fn enter_apartment() {
        // SAFETY: initialises COM for the calling thread only; there is no pointer argument to get wrong.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    }

    fn installed(container: &InkRecognizerContainer) -> windows::core::Result<Vec<InkRecognizer>> {
        let list = container.GetRecognizers()?;
        let mut out = Vec::new();
        for i in 0..list.Size()? {
            out.push(list.GetAt(i)?);
        }
        Ok(out)
    }

    pub fn recognizers() -> Result<Recognizers, String> {
        enter_apartment();
        let container = InkRecognizerContainer::new().map_err(|e| sentence("Handwriting recognition is not available", e))?;
        let mut names = Vec::new();
        for recognizer in installed(&container).map_err(|e| sentence("Could not list the handwriting recognisers", e))? {
            if let Ok(name) = recognizer.Name() {
                names.push(name.to_string());
            }
        }
        Ok(Recognizers { names })
    }

    pub fn recognize(strokes: &[InkStrokeInput], recognizer: Option<&str>) -> Result<Vec<RecognizedWord>, String> {
        enter_apartment();
        let builder = InkStrokeBuilder::new().map_err(|e| sentence("Could not rebuild the ink", e))?;
        let ink = InkStrokeContainer::new().map_err(|e| sentence("Could not rebuild the ink", e))?;
        let mut added = 0usize;
        for stroke in strokes {
            let mut points = points_of(stroke);
            if points.is_empty() {
                continue;
            }
            if points.len() == 1 {
                // A dot is still a mark (the dot on an i): two points make it a stroke.
                let (x, y, p) = points[0];
                points.push((x + 0.5, y, p));
            }
            let mut ink_points: Vec<Option<InkPoint>> = Vec::with_capacity(points.len());
            for (x, y, pressure) in points {
                let point = InkPoint::CreateInkPoint(Point { X: x, Y: y }, pressure).map_err(|e| sentence("Could not rebuild the ink", e))?;
                ink_points.push(Some(point));
            }
            let iterable: IIterable<InkPoint> = ink_points.into();
            let ink_stroke = builder
                .CreateStrokeFromInkPoints(&iterable, Matrix3x2::identity())
                .map_err(|e| sentence("Could not rebuild the ink", e))?;
            ink.AddStroke(&ink_stroke).map_err(|e| sentence("Could not rebuild the ink", e))?;
            added += 1;
        }
        if added == 0 {
            return Ok(Vec::new());
        }

        let container = InkRecognizerContainer::new().map_err(|e| sentence("Handwriting recognition is not available", e))?;
        if let Some(name) = recognizer {
            let wanted = HSTRING::from(name);
            let chosen = installed(&container)
                .map_err(|e| sentence("Could not list the handwriting recognisers", e))?
                .into_iter()
                .find(|r| r.Name().map(|n| n == wanted).unwrap_or(false));
            // A recogniser that has since been removed: Windows' default reads instead.
            if let Some(chosen) = chosen {
                container
                    .SetDefaultRecognizer(&chosen)
                    .map_err(|e| sentence("Could not choose the handwriting recogniser", e))?;
            }
        }
        let results = container
            .RecognizeAsync(&ink, InkRecognitionTarget::All)
            .and_then(|operation| operation.get())
            .map_err(|e| sentence("Windows could not read the handwriting (is handwriting installed for a language?)", e))?;

        let mut words = Vec::new();
        for i in 0..results.Size().map_err(|e| sentence("Could not read the result", e))? {
            let Ok(result) = results.GetAt(i) else { continue };
            let Ok(candidates) = result.GetTextCandidates() else { continue };
            if candidates.Size().unwrap_or(0) == 0 {
                continue;
            }
            let Ok(text) = candidates.GetAt(0) else { continue };
            let text = text.to_string();
            if text.trim().is_empty() {
                continue;
            }
            let Ok(rect) = result.BoundingRect() else { continue };
            words.push(RecognizedWord { text, x: rect.X, y: rect.Y, width: rect.Width, height: rect.Height });
        }
        Ok(words)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{InkStrokeInput, RecognizedWord, Recognizers};

    pub fn recognizers() -> Result<Recognizers, String> {
        Ok(Recognizers { names: Vec::new() })
    }

    pub fn recognize(_strokes: &[InkStrokeInput], _recognizer: Option<&str>) -> Result<Vec<RecognizedWord>, String> {
        Err("Reading handwriting needs Windows' handwriting recognition, which this device does not have.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_are_read_in_threes_and_bad_ones_dropped() {
        let stroke = InkStrokeInput { points: vec![1.0, 2.0, 0.5, f32::NAN, 3.0, 0.5, 4.0, 5.0, 7.0, 6.0, 7.0, f32::NAN, 9.0] };
        assert_eq!(points_of(&stroke), vec![(1.0, 2.0, 0.5), (4.0, 5.0, 1.0), (6.0, 7.0, 0.5)]);
    }

    #[test]
    fn a_request_and_its_answer_go_through_the_helper_s_pipes_intact() {
        let request = HelperRequest::Recognize { strokes: vec![InkStrokeInput { points: vec![1.0, 2.0, 0.5] }], recognizer: Some("English".into()) };
        let text = serde_json::to_string(&request).unwrap();
        assert!(text.contains("\"ask\":\"recognize\""), "{text}");
        match serde_json::from_str::<HelperRequest>(&text).unwrap() {
            HelperRequest::Recognize { strokes, recognizer } => {
                assert_eq!(strokes[0].points, vec![1.0, 2.0, 0.5]);
                assert_eq!(recognizer.as_deref(), Some("English"));
            }
            HelperRequest::Recognizers => panic!("asked the wrong thing"),
        }
        let words = vec![RecognizedWord { text: "pj".into(), x: 1.0, y: 2.0, width: 3.0, height: 4.0 }];
        let reply = serde_json::to_string(&HelperReply::of(Ok::<_, String>(words.clone()))).unwrap();
        assert_eq!(serde_json::from_str::<HelperReply<Vec<RecognizedWord>>>(&reply).unwrap().into_result(), Ok(words));
        let failed = serde_json::to_string(&HelperReply::<Vec<RecognizedWord>>::of(Err("no".into()))).unwrap();
        assert_eq!(serde_json::from_str::<HelperReply<Vec<RecognizedWord>>>(&failed).unwrap().into_result(), Err("no".into()));
    }

    #[test]
    fn pressure_never_reaches_zero() {
        let stroke = InkStrokeInput { points: vec![0.0, 0.0, 0.0, 1.0, 1.0, -3.0] };
        assert!(points_of(&stroke).iter().all(|&(_, _, p)| p > 0.0));
    }
}
