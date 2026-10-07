//! The desktop app's life in the background: opening when Windows starts, living in the tray, one instance.
//!
//! Three settings, kept in the app data folder (`background.json`) because they are needed before the page
//! has loaded — the page's own preferences live in its `localStorage`, out of reach at that point:
//!
//! - **Open at login** registers the app to start with Windows (the autostart plugin's `Run` entry), launched
//!   with [`AUTOSTART_ARG`] so a login start can be told from one the user made.
//! - **Start in the tray**: a login start then shows no window, only the tray icon. (The main window is
//!   created hidden on Windows — `tauri.windows.conf.json` — and shown in `setup` unless that is the case,
//!   so it does not flash up and vanish.)
//! - **Close to the tray**: closing the window hides it, and the app keeps running in the tray.
//!
//! The tray icon is there while either tray setting is on: a click opens the window, its menu opens it or
//! quits. Quitting asks the page first ([`QUIT_EVENT`]) so a recording in progress and unsaved work are kept,
//! and goes after [`QUIT_GRACE`] whatever the page does.
//!
//! One instance: a second launch (the Start menu, a file double-clicked in Explorer) brings the running app
//! forward instead — out of the tray if it is there — and hands it the file it was asked to open, through the
//! same `notex-open-with` event Android's intents use.
//!
//! On Android none of it applies (the system decides when an app runs); the commands say so.
#![cfg_attr(mobile, allow(dead_code, unused_imports))]

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The argument the login entry starts the app with.
pub const AUTOSTART_ARG: &str = "--autostart";
/// What the page is told when the tray's Quit is chosen; it answers with `quit_app`.
pub const QUIT_EVENT: &str = "notex-quit-requested";
/// How long the page has to save before a quit goes ahead regardless.
pub const QUIT_GRACE: Duration = Duration::from_secs(8);
/// The event the page opens a handed-over file on (`src/desktop/openWith.ts`).
const OPEN_WITH_EVENT: &str = "notex-open-with";
const SETTINGS_FILE: &str = "background.json";
const OPENABLE: [&str; 4] = ["notex", "json", "pdf", "goodnotes"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundSettings {
    pub open_at_login: bool,
    pub start_in_tray: bool,
    pub close_to_tray: bool,
}

impl BackgroundSettings {
    /// Whether the tray icon is wanted: a login start may put the app there, and a close may.
    pub fn wants_tray(&self) -> bool {
        (self.open_at_login && self.start_in_tray) || self.close_to_tray
    }
}

/// The settings as the page sees them, with whether this device has a background life at all.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    pub supported: bool,
    #[serde(flatten)]
    pub settings: BackgroundSettings,
}

/// The settings in force, whether a quit is under way (so a close is not turned into a hide), and whether the
/// window has yet to be shown for the first time (after a start in the tray it still has to be maximized).
#[derive(Default)]
pub struct Background {
    settings: Mutex<BackgroundSettings>,
    quitting: AtomicBool,
    never_shown: AtomicBool,
}

impl Background {
    fn settings(&self) -> BackgroundSettings {
        self.settings.lock().map(|s| *s).unwrap_or_default()
    }
}

/// Whether this is the launch Windows makes at login.
pub fn launched_at_login<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|arg| arg == AUTOSTART_ARG)
}

/// The document a launch was asked to open: its first argument (after the program) naming a file the app opens,
/// made absolute against the folder it was launched from.
pub fn file_argument(args: &[String], cwd: &str) -> Option<String> {
    args.iter().skip(1).find_map(|arg| {
        if arg.starts_with('-') {
            return None;
        }
        let path = Path::new(arg);
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        if !OPENABLE.contains(&ext.as_str()) {
            return None;
        }
        let full = if path.is_absolute() || cwd.is_empty() { path.to_path_buf() } else { Path::new(cwd).join(path) };
        Some(full.to_string_lossy().into_owned())
    })
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::data_dir::get(app).ok().map(|dir| dir.join(SETTINGS_FILE))
}

fn load(app: &AppHandle) -> BackgroundSettings {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, settings: &BackgroundSettings) -> Result<(), String> {
    let path = settings_path(app).ok_or_else(|| "No application data directory".to_string())?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    crate::commands::atomic_write(&path, text.as_bytes()).map(|_| ())
}

/// The settings, and whether this device can have them.
#[tauri::command]
pub fn background_settings(app: AppHandle) -> BackgroundStatus {
    #[cfg(desktop)]
    {
        let mut settings = app.state::<Background>().settings();
        // What Windows actually has is the truth: the entry can be removed in Task Manager's Startup apps.
        if let Ok(enabled) = desktop::login_enabled(&app) {
            settings.open_at_login = enabled;
        }
        BackgroundStatus { supported: true, settings }
    }
    #[cfg(mobile)]
    {
        let _ = app;
        BackgroundStatus { supported: false, settings: BackgroundSettings::default() }
    }
}

/// Change the settings: register or unregister the login start, keep them, and put up or take down the tray icon.
#[tauri::command]
pub fn set_background_settings(app: AppHandle, settings: BackgroundSettings) -> Result<BackgroundStatus, String> {
    #[cfg(desktop)]
    {
        desktop::set_login(&app, settings.open_at_login)?;
        store(&app, &settings)?;
        if let Ok(mut current) = app.state::<Background>().settings.lock() {
            *current = settings;
        }
        desktop::sync_tray(&app, &settings);
        Ok(background_settings(app))
    }
    #[cfg(mobile)]
    {
        let _ = (app, settings);
        Err("Starting with the system and the tray are only on Windows.".to_string())
    }
}

/// The page has saved what it had to (see [`QUIT_EVENT`]): quit now.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.state::<Background>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Load the settings and decide how the app starts: with its window, or (at login, if asked) only in the tray.
pub fn setup(app: &AppHandle) {
    let settings = load(app);
    app.manage(Background { settings: Mutex::new(settings), ..Default::default() });
    #[cfg(desktop)]
    desktop::start(app, &settings, launched_at_login(std::env::args()));
}

#[cfg(desktop)]
pub use desktop::{on_close_requested, second_instance};

#[cfg(desktop)]
mod desktop {
    use super::*;
    use serde_json::json;
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        CloseRequestApi, Emitter, Window,
    };
    use tauri_plugin_autostart::ManagerExt;

    const TRAY_ID: &str = "main";
    const MAIN_WINDOW: &str = "main";

    pub fn login_enabled(app: &AppHandle) -> Result<bool, String> {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }

    pub fn set_login(app: &AppHandle, enabled: bool) -> Result<(), String> {
        let launcher = app.autolaunch();
        let result = if enabled { launcher.enable() } else { launcher.disable() };
        result.map_err(|e| format!("Could not change starting with Windows: {e}"))
    }

    pub fn start(app: &AppHandle, settings: &BackgroundSettings, at_login: bool) {
        // The login entry names the program it starts; write it again, so it is this one — the program was
        // renamed (`notes-taking-app.exe` to `KK-Notes.exe`), and an installer can put it somewhere else.
        if login_enabled(app).unwrap_or(false) {
            let _ = set_login(app, true);
        }
        let in_tray = at_login && settings.open_at_login && settings.start_in_tray;
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            if in_tray {
                // Created hidden on Windows; elsewhere it may already be up.
                let _ = window.hide();
                app.state::<Background>().never_shown.store(true, Ordering::SeqCst);
            } else {
                let _ = window.show();
                let _ = window.maximize();
            }
        }
        if in_tray || settings.wants_tray() {
            if let Err(error) = ensure_tray(app) {
                eprintln!("tray icon: {error}");
                // No tray to come back from: the window has to be there.
                show_main(app);
            }
        }
    }

    /// Bring the window forward: out of the tray, out of the taskbar, to the front — maximized the first time,
    /// as a start with the window would have had it.
    pub fn show_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.unminimize();
            let _ = window.show();
            if app.state::<Background>().never_shown.swap(false, Ordering::SeqCst) {
                let _ = window.maximize();
            }
            let _ = window.set_focus();
        }
    }

    fn ensure_tray(app: &AppHandle) -> tauri::Result<()> {
        if app.tray_by_id(TRAY_ID).is_some() {
            return Ok(());
        }
        let open = MenuItem::with_id(app, "open", "Open KK-Notes", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit KK-Notes", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("KK-Notes")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main(app),
                "quit" => request_quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    }

    /// Put the tray icon up or take it down to match the settings — never down while the window is hidden in it.
    pub fn sync_tray(app: &AppHandle, settings: &BackgroundSettings) {
        if settings.wants_tray() {
            if let Err(error) = ensure_tray(app) {
                eprintln!("tray icon: {error}");
            }
            return;
        }
        let hidden = app
            .get_webview_window(MAIN_WINDOW)
            .map(|w| !w.is_visible().unwrap_or(true))
            .unwrap_or(false);
        if hidden {
            show_main(app);
        }
        let _ = app.remove_tray_by_id(TRAY_ID);
    }

    /// Ask the page to save and quit; quit anyway after [`QUIT_GRACE`].
    fn request_quit(app: &AppHandle) {
        app.state::<Background>().quitting.store(true, Ordering::SeqCst);
        if app.emit(QUIT_EVENT, ()).is_err() {
            app.exit(0);
            return;
        }
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(QUIT_GRACE);
            handle.exit(0);
        });
    }

    /// Closing the window with "close to the tray" on hides it instead.
    pub fn on_close_requested(window: &Window, api: &CloseRequestApi) {
        if window.label() != MAIN_WINDOW {
            return;
        }
        let app = window.app_handle();
        let state = app.state::<Background>();
        if state.quitting.load(Ordering::SeqCst) || !state.settings().close_to_tray {
            return;
        }
        api.prevent_close();
        let _ = window.hide();
        if let Err(error) = ensure_tray(app) {
            eprintln!("tray icon: {error}");
            // Nowhere to come back from: stay open.
            show_main(app);
        }
    }

    /// A second launch: bring this one forward, and open what it was asked to.
    pub fn second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
        show_main(app);
        let Some(path) = file_argument(&args, &cwd) else { return };
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else { return };
        let detail = json!({ "uri": path, "mime": "" });
        let script = format!("window.dispatchEvent(new CustomEvent({OPEN_WITH_EVENT:?}, {{ detail: {detail} }}));");
        let _ = window.eval(&script);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_login_start_is_told_by_its_argument() {
        assert!(launched_at_login(args(&["KK-Notes.exe", "--autostart"])));
        assert!(!launched_at_login(args(&["KK-Notes.exe"])));
        assert!(!launched_at_login(args(&["KK-Notes.exe", "C:\\notes\\--autostart.notex"])));
    }

    #[test]
    fn the_file_a_launch_names_is_found_and_made_absolute() {
        assert_eq!(file_argument(&args(&["app", "--autostart"]), "C:\\"), None);
        assert_eq!(file_argument(&args(&["app", "readme.txt"]), ""), None);
        assert_eq!(file_argument(&args(&["app", "C:\\a\\Lecture.PDF"]), "D:\\"), Some("C:\\a\\Lecture.PDF".to_string()));
        let relative = file_argument(&args(&["app", "Week 3.notex"]), "C:\\notes").unwrap();
        assert!(relative.starts_with("C:\\notes") && relative.ends_with("Week 3.notex"), "{relative}");
        assert_eq!(file_argument(&args(&["app", "x.goodnotes"]), ""), Some("x.goodnotes".to_string()));
    }

    #[test]
    fn the_tray_is_wanted_only_when_something_puts_the_app_there() {
        let off = BackgroundSettings::default();
        assert!(!off.wants_tray());
        assert!(!BackgroundSettings { start_in_tray: true, ..off }.wants_tray());
        assert!(BackgroundSettings { open_at_login: true, start_in_tray: true, ..off }.wants_tray());
        assert!(BackgroundSettings { close_to_tray: true, ..off }.wants_tray());
    }

    #[test]
    fn settings_read_back_with_missing_fields_off() {
        let s: BackgroundSettings = serde_json::from_str(r#"{"closeToTray":true}"#).unwrap();
        assert_eq!(s, BackgroundSettings { close_to_tray: true, ..Default::default() });
    }
}
