# KK-Notes for Windows, native (WinUI 3): handoff

This folder is where a native Windows version of KK-Notes is to be built in **WinUI 3** (C#,
Windows App SDK). Nothing is in it yet but these notes. They are for a Claude Code session running
**locally on the owner's Windows PC**, the only place a WinUI app can be built and run.

## Why

KK-Notes today is one app for Windows, Android and the browser: a React + TypeScript interface
(`src/`) inside a Tauri v2 shell (`src-tauri/`, Rust), drawn by WebView2 on Windows. It works, and
it keeps working: **Android and the current Windows build stay on it.** The native app is only for
Windows, and only worth having if it writes better.

The pain that led here, all on the owner's device, an **ASUS ROG Flow Z13** (2560×1600, 150 %
scale, 60/180 Hz, pen):

- Ink drawn through a browser canvas trails the pen. A great deal was done about it (see the README:
  *Brush engine*, *How it works*, the "fullscreen" and "low-latency" sections), but a web page cannot
  reach Windows Ink's low-latency, pen-predicted drawing.
- Windows' own fullscreen made the mouse pointer lag in the web view; a borderless window placed by
  hand had its own trouble (the invisible window frame; fixed in `src/desktop/borderless.ts`). A
  native window has neither problem.

So the first job is **a prototype that proves the ink is better**, not a port.

## Plan

1. **Prototype — the deciding step.** One WinUI 3 window with a page and the pen:
   - `InkCanvas` / `InkPresenter` (or, if it measures better, `CoreInkIndependentInputSource` with
     Win2D drawing), pressure and tilt, a few colours and widths, an eraser, undo;
   - pen, touch and mouse each doing the right thing (touch scrolls and zooms, it does not draw);
   - the pen's barrel button and eraser end (`PointerPointProperties.IsBarrelButtonPressed`,
     `IsEraser`), as the current app maps them (README: *Stylus buttons*);
   - a way to compare: the owner draws the same scribbles in both apps on the Z13 at 60 and 180 Hz.
   **Stop and ask the owner** whether it is clearly better before building more.
2. **The same files.** Read and write `.notex` (below), so a note goes back and forth between this
   app, the current Windows app and Android. Ink first, then everything else a page holds, kept
   even when this app cannot show it yet (never drop what you do not understand when saving).
3. **The library**: the same folder of `.notex` files, folders, cards with a picture of page one,
   favourites and tags, the recycle bin (`src-tauri/notes-sync/src/trash.rs` describes its layout).
4. **The rest, one feature at a time**, in the order the owner uses them: pages and templates, lasso,
   PDF (Windows has `Windows.Data.Pdf` to render pages), typed text, search, recordings, sync.
5. **Sync with Google Drive**: rather than write it again in C#, call the Rust crate
   `src-tauri/notes-sync` (it has no Tauri in it) through a C ABI, e.g. with `csbindgen`.

Matching everything the current app does is many weeks of work. Feature by feature, with the owner
testing on the Z13 between steps.

## The `.notex` file

UTF-8 JSON (`src/desktop/notex.ts`, `src/document/types.ts`, `src/document/serialization.ts`):

```jsonc
{
  "format": "notex", "version": 1,
  "savedAt": "2026-10-10T09:30:17.000Z",
  "app": { "name": "KK-Notes", "version": "0.1.0" },
  "document": {                       // SerializedDocument
    "version": 1, "id": "…", "title": "Untitled note",
    "viewMode": "vertical-continuous", "zoom": 1, "activePageIndex": 0,
    "pages": [ {                      // SerializedPage
      "id": "…",
      "dimensions": { "width": 794, "height": 1123 },   // CSS px at 96 dpi; A4 is the default
      "template": "blank",            // blank | ruled | grid | engineering | isometric | pdf
      "templateConfig": { … }, "backgroundColor": "#ffffff",
      "strokes": [ {                  // src/inking/types.ts: Stroke
        "id": "…", "kind": "freehand", "tool": "pen",
        "points": [ { "x": 120.5, "y": 88.2, "pressure": 0.42, "tilt": 0.3 } ],  // page px
        "style": { "color": "#1d1d1f", "size": 2, "opacity": 1, "compositeOperation": "source-over",
                   "thinning": 0.5, "smoothing": 0.5, "streamline": 0.5, "simulatePressure": false,
                   "taperStart": 0, "taperEnd": 0, "pattern": "solid", "arrowheads": "none", "brush": "…" },
        "bbox": { "minX": …, "minY": …, "maxX": …, "maxY": … },
        "pointerType": "pen", "createdAt": 12345.6
      } ],
      "media": [ … ],                 // images, sticky notes, tables, text boxes (optional)
      "pdf": { … }, "formFields": [ … ], "formValues": { … }, "bookmark": "…", "inkText": { … }
    } ],
    "pdfSources": { "<id>": { … base64 PDF … } },   // optional
    "recordings": [ … ]                            // optional, audio as base64
  }
}
```

- Coordinates are **page pixels** (a page is 794 × 1123 for A4), y down, independent of zoom.
- Strokes are drawn with [perfect-freehand](https://github.com/steveruizok/perfect-freehand)
  using the `style` fields; a C# port of its outline algorithm keeps ink looking the same in both apps.
  The brushes (`src/inking/engine/brushes.ts`) shape points before that.
- `kind: "geometric"` strokes are shapes (lines, rectangles, curves, a coordinate plane) with a
  `shape` instead of `points`.
- Fields this app does not know must be **kept as they are** when it saves (keep the JSON tree and
  change only what you understand), or a note round-tripped through it loses its text, PDFs or audio.

## Where the notes are on the PC

`%APPDATA%\KK-Notes\library` holds the `.notex` files and folders. `%APPDATA%\KK-Notes\trash` holds
the recycle bin. Do not write to the owner's real library while developing. Use a copy, or a
setting pointing at a test folder, until saving is proven.

## Working with the owner

- The owner tests on the Z13 with the pen; Claude builds and runs the app, and reads the build
  output and logs. Ask for a screenshot when something is visual.
- The owner writes in English or German; answer in the language of their message.
- Keep the README's style: say what was found and why something is the way it is.
- Commit on a branch (not `main`), with clear messages; push when a step works.
