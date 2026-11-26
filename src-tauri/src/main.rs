// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by the app itself to read handwriting apart from it (`handwriting.rs`): no window, no app.
    if std::env::args().any(|arg| arg == notes_taking_app_lib::HANDWRITING_HELPER_ARG) {
        notes_taking_app_lib::run_handwriting_helper();
        return;
    }
    notes_taking_app_lib::run();
}
