# Notes: multi-page inking

A React + TypeScript notes app for 2-in-1 pen/touch laptops: a low-latency
inking engine (`src/inking/`) with palm rejection, pressure-sensitive strokes
via [perfect-freehand], STEM shape tools and hold-to-snap, hosted in a
multi-page document system (`src/document/`) with procedural page templates,
canvas virtualisation, a Samsung Notes-style page arranger, an image layer,
a lasso selection tool, two-finger pan / pinch-zoom navigation, a read-only
lock, a disappearing laser pointer, notebook covers, vertical *and*
horizontal continuous scrolling, and PDF import / fillable AcroForms /
vector PDF export (`src/pdf/`). The interface is icon-first: a fixed top
bar for document context and a draggable floating palette for drawing.
Styled
with Tailwind CSS and follows the system light/dark theme.

```bash
npm install
npm run dev            # Vite dev server (web)
npm test               # unit tests (vitest)
npm run typecheck      # strict tsc
npm run build          # typecheck + production bundle + bundle guard
npm run check:bundle   # assert pdf.js / pdf-lib are lazy chunks
npm run check:rust     # cargo check of the Tauri shell (Windows MSVC target)
npm run check:android  # assert the Android project carries this repo's customizations
npm run desktop:dev    # Tauri v2 desktop shell, hot reloading
npm run desktop:build  # NSIS / MSI installers (run on Windows)
npm run android:dev    # run on a connected Android device / emulator
npm run android:apk    # ./build-android.sh — checks the toolchain, then builds a debug APK
```

## Desktop shell (Tauri v2, `src-tauri/`, `src/ui/
├── Tooltip.tsx             hover / focus / long-press tooltip
├── IconButton.tsx          icon + tooltip + loud active state
├── Popover.tsx             anchored flyout panel
├── dragBounds.ts           pure clamping for the floating palette
└── useDraggablePanel.ts    pointer dragging, re-clamped on resize

src/desktop/`)

**Setup (Windows 2-in-1 target).** Install Node 22, Rust via
[rustup](https://rustup.rs) (the MSVC toolchain, which needs the *Desktop
development with C++* workload of the Visual Studio Build Tools) and make sure
the WebView2 runtime is present (it ships with Windows 11; the NSIS/MSI
bundles download it otherwise). Then:

```bash
npm install                 # installs @tauri-apps/api, plugin-dialog, plugin-fs, @tauri-apps/cli
npm run desktop:dev         # starts Vite and the Tauri window
npm run desktop:build       # installers in src-tauri/target/release/bundle/
npx tauri icon my-icon.png  # replace the generated placeholder icons in src-tauri/icons/
```

From a non-Windows host the Rust side can still be verified without the
GTK/WebKit libraries: `npm run check:rust` runs `cargo check` for the
`x86_64-pc-windows-msvc` target (add it with `rustup target add`).

**Configuration** (`src-tauri/tauri.conf.json`). One maximized, resizable,
natively-decorated window that follows the system theme like the web UI;
WebView2 launched with hardware-accelerated rasterisation
(`--enable-gpu-rasterization --enable-zero-copy`) and Edge UI features off;
`dragDropEnabled: false` so HTML5 image/PDF drops keep reaching the page;
zoom hotkeys off; a CSP that permits the pdf.js worker, wasm codecs, data and
blob URLs and the IPC origin; `.notex` registered as a file association.
`src-tauri/capabilities/default.json` grants `dialog:default`, `fs:default`
with read/write scope under `$APPDATA`, and the window permissions used for
fullscreen, maximize and title updates.

**Rust commands** (`src-tauri/src/commands.rs`), all with atomic temp-file +
rename writes:

| Command | Purpose |
| --- | --- |
| `save_document(path, contents)` / `open_document(path)` | `.notex` JSON on disk |
| `write_binary_file` | raw IPC body → file (PDF export lands on disk without a blob download); destination in the percent-encoded `x-path` header |
| `save_draft` / `load_draft` / `clear_draft` | autosave in `app_data_dir/drafts/autosave.notex` |
| `list_recent` / `add_recent` / `remove_recent` | last five documents in `app_data_dir/recent.json`, de-duplicated, pruned when files vanish |
| `get_startup_file` | the `.notex` passed on the command line (file association), handed out once |

**`.notex` format** (`src/desktop/notex.ts`). A versioned envelope
`{ format: 'notex', version: 1, savedAt, app, document }` around the document
serialization: title, view mode, zoom, pages with dimensions, template and
config, background colour, stroke arrays (freehand and geometric), image
layers as data URLs, AcroForm fields and values, and PDF sources stored once
as base64. A bare serialized document (`.json`) is also accepted. Undo history
is not persisted.

**Frontend integration** (`src/desktop/`). `tauri.ts` detects the shell and
lazy-loads the `@tauri-apps/*` modules so the web build never pays for them.
`fileService.ts` implements Save / Save As / Open / Export PDF / drafts /
recents / fullscreen over the Rust commands and native dialogs, with browser
fallbacks (downloads, a file input, `localStorage` drafts). `fileActions.ts`
holds the File-menu actions (with an unsaved-changes prompt),
`useDesktopIntegration.ts` opens a startup file or offers the autosaved draft,
debounces autosave 1.5 s after content edits, keeps the window title in sync
with a dirty marker, binds `Ctrl+N/O/S/Shift+S/E` and `F11`, and suppresses
the WebView context menu outside text fields (Windows Ink press-and-hold would
otherwise open it mid-stroke). Dirty tracking compares the page array and
title against the last saved snapshot, so scrolling and zooming never count as
edits.

**Stylus buttons.** `resolveEffectiveTool` maps hardware buttons per the
*Stylus* settings in the palette: the eraser end (`button 5` / `buttons & 32`)
routes to the stroke or pixel eraser without touching the palette, and the
barrel button (`buttons & 2` while touching) acts as a stroke eraser, pixel
eraser, or temporary Select mode that restores the previous tool when the pen
lifts. A barrel press while merely hovering is ignored.

**Bundle.** pdf.js and pdf-lib are only reached through dynamic `import()`
(raster client, PDF background, exporter, `React.lazy` import dialog), so the
entry chunk is ~330 kB instead of ~1.2 MB; `scripts/check-bundle.mjs` fails
the build if either library ends up in the critical path.

## Document system (`src/document/`)

**State.** A Zustand store (`store.ts`) owns the `Document` (pages, active
index, view mode, zoom), a `scrollRequest` counter that asks the viewer to
scroll, the arranger's open state, the read-only lock, and the image /
lasso selections; `toolStore.ts` holds the shared tool settings. All structural edits are pure functions in `operations.ts`
(reorder, insert, duplicate with deep-cloned strokes, delete with a one-page
guard, snapshot undo/redo per page) so they can be unit-tested without React.
The inking render loop never subscribes to the store; a surface only calls
`commitStroke` / `eraseStrokes` when a gesture ends, so React updates cannot
stall a frame.

**Pages.** `Page` carries A4 dimensions (794 × 1123 CSS px at 96 DPI), a
template + `templateConfig`, background colour, the stroke list (the same
`FreehandStroke | GeometricStroke` union as the engine) and snapshot
`undoStack` / `redoStack`. `serialization.ts` round-trips a document to JSON
without history.

**Templates.** `templates.ts` generates the background lines once and feeds
two renderers: an SVG data URL used as the live page's CSS background (a few
KB, crisp at any zoom, no extra texture) and a canvas painter used by the
raster pipeline. Ruled (with margin line), grid, engineering (bold majors,
fine minors), isometric (30° triangular grid via clipped line families) and
blank/PDF placeholders. Line colours derive from the page background's
luminance unless `strokeColor` is set explicitly, so dark pages get light
lines.

**View modes.** `vertical-continuous` and `horizontal-continuous` scroll the
same page strip along different axes, and `single-page` shows one page at a
time. `layout.ts` expresses everything scroll-related along a **main axis**,
so both continuous modes share one code path: `layoutPages` places pages
down or across and centres them on the other axis, and `visibleRange`,
`currentPageIndex`, `scrollOffsetForPage` and `itemAtContent` all take the
axis. Positions stay plain `left`/`top` pairs, so `projectToPage` needs no
axis at all — a pointer anywhere in the strip lands on the right page's
local coordinates either way. The touch gestures read the axis from the
layout, so midpoint panning and pinch anchoring follow the strip.

**Notebook cover.** A document may carry an optional `cover` (`title`,
`description`, `coverColor`, `textColor`), rendered by `CoverSheet` as the
first sheet in the viewer, before page 1, in both continuous modes. It is
not a page: nothing can be drawn on it, and it takes no part in numbering,
virtualisation or export. In the layout it simply occupies the first slot
and pushes the pages along. The Page Arranger edits it (add, title,
subtitle, colours, remove), and it is part of the document's dirty state
and of the saved file.

**Viewer & virtualisation.** `layout.ts` stacks pages at the current zoom;
`DocumentViewer` mounts an `InkSurface` (two full-resolution canvases) only
for pages within 800 px of the viewport, shows a cached `ImageBitmap`
snapshot for pages within 2400 px, and renders nothing beyond that while
reserving their space. Snapshots and thumbnails come from the same pipeline
(`raster/`): a module Worker paints pages onto an `OffscreenCanvas` and
transfers the bitmap back; an LRU cache closes evicted bitmaps; a serial
main-thread queue is the fallback. Single-page mode renders just the active
page.

**Coordinates.** `InkSurface` installs `setTransform(dpr·zoom)` so every
stroke is stored in page-local CSS px, and the pointer pipeline divides
viewport offsets by the zoom (`viewportToPagePoint` / `projectToPage` in
`layout.ts`, unit-tested). Because `getBoundingClientRect()` is already
viewport-relative, scroll offsets need no separate handling.

**Page styles.** The arranger exposes `templateConfig.spacing`: a slider plus
5 / 7 / 10 mm presets (page pixels at 96 DPI) that set the ruled line
distance, the grid and engineering box size, and the isometric triangle
side. It is disabled for templates that have no spacing (blank, PDF), and
"Apply to all pages" makes it document-wide.

**Page arranger.** Slide-over dialog with a thumbnail grid. Reordering is
pointer-based (`usePointerReorder`) so it works with pen, mouse and touch
(touch drags after a short hold; short swipes still scroll); Alt+arrows move
the focused page. Operations: add before/after, duplicate, delete (disabled
on the last page), template and background per page or for all pages, and
single click to jump. The top bar shows `Page n / N`, a jump field, prev/next,
continuous/single toggle, zoom and the arranger toggle.

```
src/document/
├── types.ts            Page, Document, TemplateConfig, serialized forms
├── operations.ts       pure page/history operations
├── layout.ts           page stacking, visible ranges, coordinate projection
├── templates.ts        line generator → SVG background / canvas painter
├── serialization.ts    JSON round trip
├── store.ts            Zustand document store   toolStore.ts  shared tool settings
├── media.ts            image placement, anchored resize, rotation, z-order
├── gestures.ts         pinch / pan math, centroid anchoring across zoom changes
├── raster/             rasterize.ts, rasterWorker.ts, rasterClient.ts, rasterCache.ts
├── hooks/              useRasterBitmap, usePointerReorder, useMediaInput, useTouchGestures
└── components/         DocumentApp, TopBar, DocumentViewer, PageFrame, PageSnapshot,
                        PageArranger, PageThumbnail, MediaLayer, SelectionLayer, CoverSheet

src/desktop/
├── notex.ts            .notex envelope encode / decode
├── tauri.ts            shell detection, lazy @tauri-apps imports
├── fileService.ts      save / open / export / drafts / recents / window (desktop + browser)
├── fileActions.ts      File menu actions shared by menu and shortcuts
├── useDesktopIntegration.ts  startup file, draft restore, autosave, title, shortcuts
└── FileMenu.tsx  desktopStore.ts

src-tauri/
├── Cargo.toml  build.rs  tauri.conf.json  tauri.android.conf.json
├── capabilities/default.json  icons/
├── src/  main.rs  lib.rs  commands.rs
└── gen/android/            Gradle project (committed; see the Android section)
    ├── app/build.gradle.kts            minSdk 26, targetSdk 34, applicationId
    ├── app/src/main/AndroidManifest.xml  permissions, adjustResize
    ├── app/src/main/java/com/notex/app/MainActivity.kt  WebView + window insets
    └── buildSrc/  gradle/  settings.gradle

src/pdf/
├── pdfjs.ts            PDF.js bootstrap (legacy build, worker URL, asset paths)
├── pdfCoords.ts        PDF ↔ page projection, import geometry
├── forms.ts            AcroForm extraction and value sync
├── import.ts           load, describe and build pages from a PDF
├── pdfRenderer.ts      cached page backgrounds
├── pdfOps.ts           strokes → pdf-lib drawing ops (pure)
├── export.ts           pdf-lib assembly: copy, fill, embed, burn
├── FormOverlay.tsx  PdfBackground.tsx  ImportPdfDialog.tsx
└── download.ts
```

## Interface (`src/ui/`, `src/inking/palette/`)

Tablet-first and icon-only, with [lucide-react] for the icons and a small
tooltip of our own rather than another dependency.

**Top app bar** — fixed, blurred, three groups:

| Group | Contents |
| --- | --- |
| Left | File menu, page arranger, undo, redo |
| Centre | Previous / next page, the title (click to rename), the dirty dot, a page badge that turns into a jump-to-page field |
| Right | Zoom, a view-mode button that rotates vertical → horizontal → single, the read-only lock, import and export |

As the window narrows the zoom read-out and the word "Page" drop away and
the title truncates; the icons stay, so nothing becomes unreachable.

**Floating tool palette** — a draggable panel over the canvas. The first row
groups the tools (select, lasso, laser, insert image · pen, highlighter ·
line, coordinate system, stroke options · eraser · settings) and the second
carries the colour swatches and the thickness slider. Tools that have more
to say open a flyout when their own button is pressed again: the pen's five
brushes, the coordinate plane's quadrants and labels. The eraser is one
button with two modes, the pattern / snapping and the input / stylus
settings each live behind a popover, and everything the old text toolbar
could do is still there.

Dragging is handled by `useDraggablePanel` on top of the pure clamping in
`dragBounds.ts`: the palette is kept fully inside the canvas area with a
12 px margin, is re-clamped whenever the window or the panel itself
resizes (so rotating a tablet cannot strand it off-screen), and a
double-click on its grip returns it to the bottom centre.

**Tooltips and touch** — `Tooltip` opens after 300 ms of mouse hover,
immediately on keyboard focus, and after a 500 ms long press for touch and
pen, which have no hover at all. It closes on Escape, and stays out of the
way while the button's own popover is open. Each trigger keeps its own
`aria-label`, identical to the tooltip text, so the bubble is purely visual
(`aria-hidden`). Because a stylus user never sees hover, the selected tool
is *filled*: a solid blue background plus a ring, not a subtle outline.

**Read-only** — locking fades the whole palette out over 200 ms and makes it
inert; only the top bar and a slim status pill remain. The pill keeps the
laser pointer reachable, since that is the one tool a locked document still
allows.

[lucide-react]: https://lucide.dev

## Brush engine (`src/inking/engine/brushes.ts`)

The pen tool paints with one of five presets, picked from the palette's pen
flyout. A
brush decides three things at once: the perfect-freehand parameters baked
into the stroke when it starts, the pressure→radius easing and end tapers
applied when the outline is generated, and how that outline is painted.

| Brush | Feel | How |
| --- | --- | --- |
| Ballpoint | Even width, hard edges | `thinning 0.08`, polygon outline drawn without curve smoothing |
| Fountain pen | Swells with pressure, flicks to a hairline | `thinning 0.78`, ease-in-out radius, taper that grows with nib speed |
| Pencil | Grainy graphite that answers to tilt | grain pattern fill, per-chunk opacity, nib widened by lean |
| Marker | Thick chisel tip, translucent ink | `2.4×` width, `multiply` at 62 %, flat caps, bleeding edge |
| Brush | Wet, very smooth, very pressure-sensitive | `smoothing 0.85`, `thinning 0.86`, long end taper, spreading edge |

Only the brush *id* is stored on a stroke: everything else is looked up from
it at paint time, so a brush stays one definition and strokes serialise as
before plus one short string. Unknown or missing ids fall back to the
ballpoint, which keeps files written before the brush engine readable.

**Painting.** A stroke's body is a list of passes — a filled outline, a
grain-textured fill, or a soft wide edge stroked under the body. The marker
and the wet brush add two graduated bleed passes so their edges fade out
instead of ending in a band. The pencil is painted in chunks along the
stroke, each with its own opacity from the pressure and tilt of the samples
it covers and its own nib width from their lean; the chunks are pre-smoothed
once and tiled flat end to flat end, so neither seams nor double-painted
overlaps show. The grain itself is a deterministic two-octave noise tile,
built once per colour and used as a repeating `createPattern` fill.

**Tilt.** `tiltX`/`tiltY` are folded into a single 0..1 lean and recorded on
each sample, but only when the digitiser reports one, so strokes from a
device without tilt stay exactly as small as before. A leaning pencil draws
broader and lighter, the way graphite spread over more paper does.

## Lasso selection and touch navigation

**Lasso tool** (`src/inking/engine/lasso.ts`, `SelectionLayer.tsx`). The
`lasso` tool mode draws a freehand loop on the live canvas (pen or mouse).
When the loop closes, every stroke on the page is tested with a ray-casting
point-in-polygon check: the stroke's bounding box must intersect the loop's,
and at least half of its sample points — the raw samples of a freehand
stroke, or points spread evenly along the flattened outline of a geometric
shape — must fall inside the polygon. Both `FreehandStroke` and
`GeometricStroke` are selectable; pixel-eraser strokes are skipped. The
selection (`lassoSelection` in the store: page id + stroke ids) shows up as
a dashed box on a z-25 layer between the ink and the form widgets:

- **drag the box** to translate, **drag a corner handle** to scale about the
  opposite corner (uniform by default, Shift for free aspect; line widths
  scale with the geometric mean of the axes);
- **quick actions**: Duplicate (offset copies become the new selection),
  six colour swatches plus a colour picker, a width slider that previews
  live and commits on release, Delete, Deselect; Delete / Backspace and
  Escape work from the keyboard.

While a drag is in flight the originals are hidden on the committed layer
(`hiddenStrokeIds`) and transformed copies are drawn on the selection
layer's own canvas, so nothing is written to the store until the pointer
lifts. Every commit (`transformSelection`, `restyleSelection`,
`duplicateSelection`, `deleteSelection`) replaces the page's stroke array
through `withStrokes`, i.e. it is exactly one entry on that page's undo
stack. Transforms keep stroke ids, so a selection stays valid across undo /
redo of its own edits; a new lasso, or switching to any tool other than
Lasso / Select, clears it.

**Two-finger navigation** (`src/document/gestures.ts`,
`hooks/useTouchGestures.ts`). The viewer's scroll container has
`touch-action: none` and tracks touch pointers itself:

- **one finger** (Touch Draw off) pans the scroll offsets directly;
- **exactly two fingers** start a gesture: the midpoint's movement pans and
  the change in finger distance zooms (rounded to 1 %, clamped to 25–300 %).
  The gesture is previewed with a CSS `translate() scale()` on the page
  column, anchored at the scroll-content point under the starting centroid,
  and committed once when a finger lifts: the store's zoom changes, the
  layout is rebuilt at the new scale, and a layout effect re-scrolls so the
  page point that was under the centroid is still under it. Same-zoom
  gestures (pure pans) commit synchronously.

A process-wide flag (`engine/gestureState.ts`) tells every `InkSurface`
that a two-finger gesture is active: the pointer pipeline refuses touch
input for its duration and cancels any touch stroke already in progress,
even with Touch Draw on — so a pinch can never leave a mark. The pen always
wins: touches are ignored while a pen was seen recently or is hovering
(the same 700 ms / 3 s windows palm rejection uses), a pen landing ends a
pinch and cancels a one-finger pan (it was a palm), and pen input is never
blocked by a gesture. A finger left over after a pinch is ignored until it
lifts, so lifting fingers one at a time does not nudge the view.

Verification: `src/inking/__tests__/lasso.test.ts` (polygon containment on
concave loops, freehand polylines and geometric outlines, transforms,
restyle, duplicate, handle geometry), `src/document/__tests__/gestures.test.ts`
(pinch math, anchoring across a zoom change) and
`src/document/__tests__/selectionStore.test.ts` (store actions and undo
integrity); a headless Chromium suite exercises lasso selection, drag
translation with preview, undo / redo, duplicate, recolour, width, corner
scaling, delete, and the two-finger gestures including the Touch Draw and
resting-palm cases.

## Android (`src-tauri/gen/android/`, `build-android.sh`)

The same web build runs on an Android tablet through Tauri v2's mobile
target. The package is **`com.notex.app`**, **minSdk 26** (Android 8.0) and
**targetSdk 34** (Android 14); it compiles against SDK 36 because the
AndroidX libraries Tauri's template pulls in require it, which is allowed as
long as `compileSdk >= targetSdk`.

### Prerequisites

The APK cannot be built from a checkout alone — Google's SDK and NDK have to
be on the machine:

| Requirement | How |
| --- | --- |
| JDK 17+ | Android Studio ships one (`/opt/android-studio/jbr`), or install OpenJDK and set `JAVA_HOME` |
| Android SDK | Android Studio → **SDK Manager** → SDK Platforms: *Android 14 (API 34)*; SDK Tools: *Android SDK Build-Tools*, *Platform-Tools*, *Command-line Tools* |
| `ANDROID_HOME` | `export ANDROID_HOME="$HOME/Android/Sdk"` (macOS: `~/Library/Android/sdk`) |
| Android NDK | SDK Manager → SDK Tools → **NDK (Side by side)** |
| `NDK_HOME` | `export NDK_HOME="$ANDROID_HOME/ndk/<version>"` |
| Rust targets | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |

`./build-android.sh --check` verifies all of that and says exactly what is
missing before anything long-running starts.

### Building

```bash
./build-android.sh                     # debug APK, signed with the debug key — installs directly
./build-android.sh --release           # unsigned release APK
npm run tauri android build -- --apk   # the same release build, straight from the CLI
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

A release APK is **unsigned**: `zipalign` and `apksigner` it with your own
keystore before installing it anywhere.

### What is committed, and what is generated

`src-tauri/gen/android/` is in the repository so the Android project can be
reviewed and diffed. Three kinds of files live there:

- **Tauri's template** — Gradle wrapper, `buildSrc` (the Rust plugin that
  cross-compiles the shell into `jniLibs`), resources.
- **This project's customizations** — the manifest permissions, the SDK
  levels, and `MainActivity.kt`. `tauri android init` regenerates the
  template and would overwrite them, so they are applied by
  `scripts/android-customize.mjs`, which is idempotent, runs from
  `build-android.sh` after an init, and doubles as a checker
  (`npm run check:android`) that also scans every Android resource for
  malformed XML.
- **Machine-specific files** (`tauri.settings.gradle`, `tauri.build.gradle.kts`,
  `tauri.properties`, `jniLibs/`, the bundled `tauri.conf.json`) — generated
  by the CLI, and git-ignored, because they contain absolute paths into the
  local Cargo registry.

`src-tauri/tauri.android.conf.json` holds the Android-only configuration
overrides; Tauri merges it on top of `tauri.conf.json` automatically for
mobile builds.

### Permissions and storage

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
```

Saving a `.notex` file and exporting a PDF go through the **Storage Access
Framework**: `plugin-dialog` opens the system picker and `plugin-fs` writes to
the URI it hands back, which grants access to that one file and needs no
permission on any Android version. `READ_MEDIA_IMAGES` is what the image
picker behind *Insert image* needs on Android 13+, and the two legacy storage
permissions cover the same ground on Android 12 and older — capped with
`maxSdkVersion` so a modern device never sees a broad storage prompt. (There
is no `READ_MEDIA_DOCUMENTS` permission in Android; documents are reached
through the Storage Access Framework, which is exactly what the file plugins
use.)

### Tablet and stylus accommodations

- **Viewport**: `interactive-widget=resizes-content` makes the Android
  keyboard resize the content instead of shrinking the visual viewport, so
  tapping an AcroForm field cannot silently rescale the canvas under the pen.
  `viewport-fit=cover` is what makes `env(safe-area-inset-*)` report anything.
- **Safe areas**: `--safe-top` / `--safe-right` / `--safe-bottom` /
  `--safe-left` resolve to `max(env(safe-area-inset-*), var(--android-inset-*))`.
  `env()` only covers display cutouts on Android, so `MainActivity` reads the
  real `WindowInsetsCompat` and writes `--android-inset-*` onto the document
  element. The top bar pads itself with `--safe-top`, the arranger and the
  read-only pill with the others, and the floating palette measures them
  through a hidden probe element so it can never be dragged under the status
  bar or the gesture pill.
- **Stylus**: the WebView already delivers `TOOL_TYPE_STYLUS` MotionEvents as
  pointer events with `pointerType === 'pen'`, pressure and tilt, so the
  inking engine needs no Android-specific code. `MainActivity` only switches
  off the things that would *intercept* them: Android 14's system handwriting
  (which captures pen strokes starting on a focusable element), the overscroll
  glow, and the WebView's built-in pinch zoom, which would fight the app's own
  two-finger gestures.

## Presenting: read-only lock and laser pointer

**Read-only lock.** The top bar's **Lock** toggle puts the document into
read-only mode. The lock is a store invariant rather than a UI convention:
every action that changes document content is wrapped in a guard
(`edit()` in `store.ts`), so while it is set, nothing — a stray pointer
event, a keyboard shortcut, a dropped file, a page operation — can modify
the document. What stays available is everything that is not an edit:

- continuous scrolling and single-page navigation with wheel, scrollbar,
  one finger and two fingers, plus the top bar's jump / prev / next, view
  mode and zoom (a locked page never inks, so one finger pans it even with
  Touch Draw on);
- **AcroForm widgets**, which keep taking input: filling in a form is not
  an edit to the document's ink, and the pen stops being forwarded to the
  ink canvas so it operates the widgets directly;
- the page arranger for navigation, with its editing controls (add,
  duplicate, delete, reorder, template, background) disabled.

The floating palette fades out and a read-only pill takes its place, the ink and
media layers go inert (`pointer-events: none`, so pointer input reaches the
scroll container), selections are dropped, and undo / redo / delete
shortcuts are switched off. Locking is view state: it never marks the
document dirty and is not part of a saved file.

The laser pointer is the one tool that keeps working while locked — it
writes nothing to the document, so there is nothing to protect it from —
and the pill carries a toggle for it, since the palette is gone. A locked
page takes the laser from a pen or mouse only, so one finger still pans.

**Laser pointer.** A `laser-pointer` tool for pointing at things while
presenting. It is *ephemeral*: `isEphemeralTool()` marks it, `appendStroke`
refuses it, and `StrokeBuilder` cannot even accumulate one, so its marks
exist on the live preview canvas only — never in a stroke array, an undo
stack, a `.notex` file or a PDF export.

The trail (`src/inking/engine/laser.ts`) is a list of timestamped samples,
each carrying the colour and width it was drawn with. A sample's opacity
decays linearly to nothing over `LASER_FADE_MS` (2.7 s) and is then
dropped, which produces both behaviours from one rule: while the pen keeps
moving the tail dissolves 2.7 s behind the tip, and after `pointerup` the
last sample — drawn at the moment of release — takes exactly 2.7 s to
vanish. Widths follow pressure around the toolbar's width, the laser keeps
its own colour (so switching tools never disturbs the ink colour), and
**Rainbow** cycles the hue along the trail. Rendering batches the trail
into a few dozen polylines (`laserRuns`) drawn in three passes — glow,
beam, bright core — and the surface keeps its own animation frame running
until the last sample expires.

The brush engine, the cover and horizontal mode are covered by
`src/inking/__tests__/brushes.test.ts` (presets, easing, tilt, velocity
taper, chunking, grain), `src/document/__tests__/brushSerialization.test.ts`
(every brush id, its baked parameters and per-sample tilt survive a save,
and a pre-brush file still loads) and
`src/document/__tests__/horizontalLayout.test.ts` (axis-aware layout,
virtualisation and pointer projection, plus the cover's slot). A headless
Chromium suite draws with each brush and measures the result: constant width
for the ballpoint, a swelling stroke for the fountain pen, a grainy fill
with no solid pixels for the pencil (broader and lighter when tilted),
multiply darkening where marker strokes cross, and a soft skirt around the
wet brush's core. The same suite adds a cover, drives the spacing presets
and checks that a pointer projects onto the right page while the strip is
scrolled sideways.

Verification: `src/inking/__tests__/laser.test.ts` (fade curve, pruning,
sampling, rainbow hues, run batching, the ephemeral-tool set),
`src/document/__tests__/laserPersistence.test.ts` (a laser stroke changes
neither the stroke array nor the history, and never appears in a save) and
`src/document/__tests__/readOnly.test.ts` (every content action is a no-op
while locked; navigation, zoom and form values still work). A headless
Chromium suite draws with the laser and measures the live canvas fading to
zero while the committed canvas stays empty, then locks the document and
checks that the pen cannot draw while the wheel and a one-finger drag still
scroll, the arranger's edit controls are disabled and form fields still
accept input.

## PDF, forms and media (`src/pdf/`, `src/document/media.ts`)

**Page layer stack.** Every page frame is an isolated stacking context with,
in page-local coordinates: `z-0` background (template SVG or the PDF.js
raster), `z-10` media (placed images with transform boxes), `z-20` the ink
surface (live + committed canvases), `z-30` the AcroForm overlay (HTML
controls). The **Select** tool makes the ink surface transparent to pointer
events so images and widgets can be manipulated; with a drawing tool active,
mouse and touch still operate the form controls, while a stylus landing on a
widget is forwarded to the ink canvas (which captures the pointer), so the pen
draws over the whole page.

**Import** (`import.ts`, `ImportPdfDialog.tsx`). PDF.js parses the file
(worker via a Vite `?url` import; the *legacy* build is used because the
modern build needs `Map.prototype.getOrInsertComputed`, which browsers only a
few releases old lack). The dialog offers *Import all* or a visual /
range selection with PDF.js thumbnails, keeps the original page size
(72 → 96 DPI) or fits pages uniformly into A4, and inserts at the end or after
the current page. Each imported page stores a `PdfPageRef` (shared source
bytes, page index, view box, rotation, scale), `template: 'pdf'`, the
extracted `formFields` and their initial `formValues`. Page backgrounds render
through `pdfRenderer.ts` (per-source document cache, per-width bitmap LRU) and
feed the same raster pipeline as templates for snapshots and thumbnails.
PDF.js runtime assets (standard fonts, CMaps, wasm codecs, ICC profiles) are
staged into `public/pdfjs/` by a small Vite plugin.

**Coordinates** (`pdfCoords.ts`). PDF user space is bottom-left, points;
pages are top-left, CSS px. For an unrotated page
`scale = pageWidth / viewBoxWidth`, `x = (rect[0] − x0)·scale`,
`y = (y1 − rect[3])·scale`; rotated pages (90/180/270) map every corner
through the same rotation-aware projection, and `pagePointToPdf` is its exact
inverse (used by the exporter).

**Forms** (`forms.ts`, `FormOverlay.tsx`). Widget annotations from
`getAnnotations({ intent: 'display' })` become `text` / `textarea` /
`checkbox` / `radio` / `select` / `listbox` fields with page-local boxes,
export values, options, max length and alignment. Values live in
`page.formValues`: checkboxes are booleans, radio groups store the selected
export value under the group name, everything else is a string.

**Media** (`media.ts`, `MediaLayer.tsx`, `useMediaInput.ts`). Paste
(`Ctrl+V`) or drop images onto a page (dropped PDFs import). Images are data
URLs with `{x, y, width, height, rotation, zIndex}`. The transform box has
eight resize handles (aspect locked by default, Shift for free transform,
anchored on the opposite edge so rotated boxes resize predictably), a rotation
handle (Shift snaps to 15°), body drag, and a contextual toolbar / right-click
for Delete, Bring to front and Send to back. `Delete` removes the selection.

**Export** (`export.ts`, `pdfOps.ts`). `exportDocumentToPdf(doc)` builds a
pdf-lib document: PDF-backed pages are `copyPages` copies of the source so
original vectors, fonts and searchable text survive; the source's AcroForm is
filled from `formValues` first (appearances regenerated) and an AcroForm is
rebuilt in the output from the copied widgets so the fields stay interactive.
Template pages get their background and grid as vector lines. Images embed as
PNG / JPEG (others re-encoded). Strokes are burned as vectors through the
pure, unit-tested `strokeToPdfOps`: perfect-freehand outlines become
`M … L … Z` paths for `drawSvgPath`, dashed centrelines are stroked paths with
scaled dash arrays, lines / rectangles / ellipses use `drawLine`,
`drawRectangle`, `drawEllipse` (falling back to paths on rotated source
pages), highlighter uses the Multiply blend, and coordinate planes become
lines, arrowheads and text. The pixel eraser cannot be represented as vectors
and is skipped. *Export PDF* in the top bar downloads the result.

## Inking engine (`src/inking/`)

```tsx
import { useRef } from 'react';
import { InkingCanvas, type InkingCanvasHandle, type Stroke } from './inking';

function Page() {
  const ink = useRef<InkingCanvasHandle>(null);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <InkingCanvas
        ref={ink}
        initialSettings={{ tool: 'pen', color: '#1f1f24', size: 4 }}
        onStrokesChange={(strokes: readonly Stroke[]) => save(strokes)}
      />
    </div>
  );
}
```

`InkingCanvas` is the standalone single-surface component (own history and
palette); `InkSurface` is the page-sized, history-free surface the document
viewer hosts. `InkingCanvas` fills its parent. `ref` exposes `undo()`,
`redo()`, `clear()`, `getStrokes()` and `toDataURL()`.

| Prop | Default | Purpose |
| --- | --- | --- |
| `initialStrokes` | `[]` | Seed strokes (uncontrolled) |
| `onStrokesChange` | – | Fired after every committed change |
| `initialSettings` | pen, 4 px, dark grey | Initial toolbar state |
| `showToolbar` | `true` | Render the built-in tool palette |
| `allowMouse` | `true` | Let a mouse draw (desktop convenience) |
| `background` | `#ffffff` | Colour behind the ink, also used by `toDataURL` |
| `maxHistory` | `200` | Undo depth |

Keyboard: `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` or `Ctrl+Y` redo.

## Tools

| Tool | Gesture | Output |
| --- | --- | --- |
| Lasso | freehand loop | selects enclosed strokes (see above) |
| Pen | freehand | pressure-thinned perfect-freehand polygon |
| Highlighter | freehand | 4× width, `multiply` at 35 % |
| Laser | freehand | glowing trail that fades out in 2.7 s, never committed |

The pen's **brush** picker chooses between ballpoint, fountain pen, pencil,
marker and wet brush (see the brush engine above).
| Line | drag | straight segment / vector |
| Axes | drag from the origin | coordinate plane |
| Stroke eraser | sweep | removes whole strokes |
| Pixel eraser | freehand | `destination-out` stroke |

Every ink tool shares the palette's **pattern** (solid, dashed, dotted,
dash-dot, long dash) and **arrowhead** mode (off, end, both). **15° snap**
constrains lines and vectors to 15° increments; **Hold to snap** turns a
freehand stroke into a primitive when you pause at its end.

### Hold to snap

Keep the pen still (within 5 px) for one second before lifting it and the
raw preview is replaced by the recognised shape, which is what gets
committed. `engine/shapeRecognition.ts`:

1. Reject paths with a bounding diagonal under 8 px.
2. **Line** when the chord covers ≥ 60 % of the path and no sample deviates
   from it by more than 6 % of its length.
3. Resample to uniform arc length, then split on whether the endpoints meet.
4. Closed paths: fit an ellipse by PCA; in that ellipse's unit frame run
   corner detection (RDP on the ring + merge + collinear pruning) so any
   ellipse looks like a circle (≥ 7 vertices) while polygons keep their true
   corner count. Accept **circle / ellipse** when the normalised radial
   coefficient of variation is below 0.1. Otherwise **heart** (two lobes, a
   notch ≥ 12 % of the height, bottom point centred), **rectangle** (four
   corners within 20° of right angles → oriented fit, snapped to the bounding
   box when within 8° of the axes), or an n-gon **polygon** (3–8 corners:
   triangle, quadrilateral, pentagon…).
5. Open paths: RDP with 5 % of the diagonal; 3–6 vertices with no segment
   shorter than 10 % of the length become a **polyline** (L, V, Z shapes).

### Angle HUD

While a line is being dragged (or previewed by hold-to-snap) the live layer
shows `θ = 45.0°` from the horizontal in math convention (y up), an
interior-angle arc `∠ = …` wherever an end sits on an existing line or
polyline endpoint (within 14 px), and the acute angle at each crossing with
one. Nothing from the HUD is committed.

### Coordinate plane

Pointer-down is the origin; the drag distance sets the half-axis extents.
*Quadrant I* grows up and right, *4 quadrants* mirrors both axes. The second
flyout configures divisions per half-axis, the faint grid, numbered
ticks and the axis labels (with presets such as `t / y`, `σ / jω`, `Re / Im`,
`Q / P`). Axes, ticks, arrowheads and labels are drawn as vectors and text
directly on the canvas.

## How it works

**Two stacked canvases.** `committed` holds finished strokes and is only
touched when history changes: appending a stroke draws just that stroke;
undo, erase and resize replay the list. `live` shows the stroke in progress
and is cleared and repainted once per `requestAnimationFrame` from all the
samples received since the previous frame. Both contexts are created with
`desynchronized: true` so Chromium can present outside the compositor's vsync.

**High-DPI.** A `ResizeObserver` (preferring `device-pixel-content-box`)
sizes the backing stores to `css × devicePixelRatio` (capped at 3×) and
installs a matching `setTransform`, so every drawing routine works in CSS
pixels and stored strokes are resolution-independent. `touch-action: none`
on the surface hands every gesture to the pointer handlers.

**Stylus & palm rejection** (`engine/pointerPolicy.ts`, pure and unit-tested).
Pen input always draws. Touch draws only when the *Touch Draw* toggle is on
and no pen has been seen for 700 ms; a pen flagged as hovering blocks touch
until it leaves (or the flag goes stale after 3 s). A pen landing while a
finger stroke is in progress discards that stroke. Pressure is clamped to
`(0, 1]` with `0` mapped to `0.5`. The pen's eraser end, or barrel button
while touching, temporarily selects the stroke eraser. `getCoalescedEvents()`
recovers the full 240 Hz sample stream, and pointer capture keeps strokes
alive past the element edge.

**Strokes.** `Stroke` is a union of `FreehandStroke` (raw samples) and
`GeometricStroke` (a `Shape`: line, polyline, polygon, rectangle, ellipse,
heart or coordinate plane). Both carry the same frozen `StrokeStyle`, so the
history reducer, hit-testing and rendering treat them uniformly.

- Solid freehand strokes go through perfect-freehand's `getStroke`
  (`engine/strokeOutline.ts`): streamline the input, derive a per-point
  radius from pressure (or from velocity for pointers without a sensor),
  offset left/right along the normal, and fill the resulting polygon with
  `nonzero` winding.
- Dashed/dotted freehand strokes and every geometric primitive are **stroked
  paths**: the centreline is RDP-simplified and resampled at equal arc-length
  spacing (`engine/simplify.ts`), then drawn with `ctx.stroke()`, round caps
  and `setLineDash` (a near-zero dash with round caps produces dots).
- Arrowheads are filled triangles placed on the tangent estimated over the
  trailing 12 px of the path; stroked shafts are trimmed under the head so
  translucent ink never shows through.

Render plans (`Path2D` objects) for committed strokes are memoised in a
`WeakMap`; the coordinate plane is drawn directly since it mixes line widths
and text.

**Tools.**

- *Pen* – `source-over`, `thinning 0.6`.
- *Highlighter* – 4× width, constant, `multiply` at 35 % opacity. While the
  stroke is live the `live` canvas gets `mix-blend-mode: multiply` so the
  preview matches the committed result.
- *Pixel eraser* – a stroke rendered with `destination-out`. It is stored in
  history like any other stroke, so undo/redo replay it naturally. Because
  `destination-out` is invisible on the transparent preview layer it paints
  straight onto `committed` while live (re-applying the same outline on
  commit is idempotent; a cancel triggers a replay).
- *Stroke eraser* – hit-tests the eraser sweep against every stroke with a
  segment-to-segment distance test (`engine/hitTest.ts`), hides hits during
  the drag and removes them as one undoable action on release.

**History** (`engine/history.ts`). A command stack: `add` stores the stroke,
`remove` stores strokes with their original indices, `clear` stores the list.
Undo inverts, redo re-applies, depth is capped.

## Layout

```
src/inking/
├── InkingCanvas.tsx        standalone component: layers, history, imperative handle
├── InkSurface.tsx          page-sized surface for the document viewer (zoom-aware)
├── palette/                floating tool palette
│   ├── ToolPalette.tsx     icon groups, flyouts, colour and thickness rows
│   └── parts.tsx           brush flyout, stroke options, plane options, settings
├── InkingCanvas.module.css
├── types.ts                Stroke, StrokeStyle, ToolSettings, HistoryEntry, …
├── constants.ts
├── engine/                 framework-free, unit-tested core
│   ├── strokeOutline.ts    perfect-freehand integration → Path2D
│   ├── renderer.ts         fills vs. stroked paths, dashes, arrowheads, plane, HUD
│   ├── shapes.ts           primitives, drag construction, plane layout, flattening
│   ├── shapeRecognition.ts hold-to-snap classifier (RDP, PCA ellipse, corners, heart)
│   ├── simplify.ts         Ramer–Douglas–Peucker, arc-length resampling, tangents
│   ├── angles.ts           15° snapping, math-convention read-outs
│   ├── angleHud.ts         connected / intersecting angle arcs
│   ├── hitTest.ts          stroke-eraser geometry for both stroke kinds
│   ├── history.ts          undo/redo reducer
│   ├── pointerPolicy.ts    palm rejection, pressure, button mapping
│   ├── lasso.ts            point-in-polygon selection, stroke transforms, handle geometry
│   ├── brushes.ts          pen presets: perfect-freehand params, tilt, grain, tapers
│   ├── laser.ts            disappearing pointer trail: fade, rainbow, run batching
│   ├── gestureState.ts     shared two-finger-gesture flag and pen presence
│   ├── toolStyles.ts       per-tool StrokeStyle
│   ├── strokeBuilder.ts    in-progress freehand accumulator
│   └── geometry.ts
└── hooks/
    ├── usePointerInk.ts    pointer state machine, dwell timer, drag shapes, rAF rendering
    ├── useHiDpiCanvas.ts   DPR-aware sizing from a container
    ├── usePageCanvas.ts    DPR × zoom sizing from page dimensions
    ├── useHistory.ts
    ├── useUndoRedoShortcuts.ts
    └── useLatestRef.ts
```

[perfect-freehand]: https://github.com/steveruizok/perfect-freehand
