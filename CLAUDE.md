# KK-Notes

A pen-first notes app. `README.md` explains how everything works and why; read the section for the
part you touch before changing it.

- **Current app** (Windows, Android, browser): React + TypeScript in `src/`, Tauri v2 shell in
  `src-tauri/` (Rust; the library, sync and recycle bin are in `src-tauri/notes-sync`).
  Checks: `npm run typecheck`, `npm test`, `npm run check:rust`, `npm run test:rust`, and the browser
  checks `npm run check:ui` (needs `npm run build` and a preview server on port 4173).
- **Native Windows app (WinUI 3)**, being started in `windows-native/`: read
  `windows-native/HANDOFF.md` first, and use the `winui-build-run` skill to build and run it.
  Android and the current Windows app stay on the Tauri app.

The owner tests on an ASUS ROG Flow Z13 with a pen, and writes in English or German.
