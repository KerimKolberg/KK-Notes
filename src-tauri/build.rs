fn main() {
    // `option_env!("NOTEX_GOOGLE_CLIENT_ID")` is read at compile time, and
    // cargo does not know that unless it is told: without this, changing the
    // variable and rebuilding silently keeps the old value baked in, which is
    // the kind of thing that costs an afternoon.
    println!("cargo:rerun-if-env-changed=NOTEX_GOOGLE_CLIENT_ID");
    tauri_build::build()
}
