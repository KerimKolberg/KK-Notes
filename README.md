# Notes: multi-page inking

A React + TypeScript notes app for 2-in-1 pen/touch laptops: a low-latency
inking engine (`src/inking/`) with palm rejection, pressure-sensitive strokes
via [perfect-freehand], STEM shape tools and hold-to-snap, hosted in a
multi-page document system (`src/document/`) with procedural page templates,
canvas virtualisation, a Samsung Notes-style page arranger, an image layer,
and PDF import / fillable AcroForms / vector PDF export (`src/pdf/`). Styled
with Tailwind CSS and follows the system light/dark theme.

```bash
npm install
npm run dev            # Vite dev server (web)
npm test               # unit tests (vitest)
npm run typecheck      # strict tsc
npm run build          # typecheck + production bundle + bundle guard
npm run check:bundle   # assert pdf.js / pdf-lib are lazy chunks
npm run check:rust     # cargo check of the Tauri shell (Windows MSVC target)
npm run desktop:dev    # Tauri v2 desktop shell, hot reloading
npm run desktop:build  # NSIS / MSI installers (run on Windows)
```

## Desktop shell (Tauri v2, `src-tauri/`, `src/desktop/`)

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
*Stylus* settings in the toolbar: the eraser end (`button 5` / `buttons & 32`)
routes to the stroke or pixel eraser without touching the toolbar, and the
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
scroll, and the arranger's open state; `toolStore.ts` holds the shared tool
settings. All structural edits are pure functions in `operations.ts`
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
├── raster/             rasterize.ts, rasterWorker.ts, rasterClient.ts, rasterCache.ts
├── hooks/              useRasterBitmap, usePointerReorder, useMediaInput
└── components/         DocumentApp, TopBar, DocumentViewer, PageFrame, PageSnapshot,
                        PageArranger, PageThumbnail, MediaLayer

src/desktop/
├── notex.ts            .notex envelope encode / decode
├── tauri.ts            shell detection, lazy @tauri-apps imports
├── fileService.ts      save / open / export / drafts / recents / window (desktop + browser)
├── fileActions.ts      File menu actions shared by menu and shortcuts
├── useDesktopIntegration.ts  startup file, draft restore, autosave, title, shortcuts
└── FileMenu.tsx  desktopStore.ts

src-tauri/
├── Cargo.toml  build.rs  tauri.conf.json  capabilities/default.json  icons/
└── src/  main.rs  lib.rs  commands.rs

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
toolbar); `InkSurface` is the page-sized, history-free surface the document
viewer hosts. `InkingCanvas` fills its parent. `ref` exposes `undo()`,
`redo()`, `clear()`, `getStrokes()` and `toDataURL()`.

| Prop | Default | Purpose |
| --- | --- | --- |
| `initialStrokes` | `[]` | Seed strokes (uncontrolled) |
| `onStrokesChange` | – | Fired after every committed change |
| `initialSettings` | pen, 4 px, dark grey | Initial toolbar state |
| `showToolbar` | `true` | Render the built-in toolbar |
| `allowMouse` | `true` | Let a mouse draw (desktop convenience) |
| `background` | `#ffffff` | Colour behind the ink, also used by `toDataURL` |
| `maxHistory` | `200` | Undo depth |

Keyboard: `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` or `Ctrl+Y` redo.

## Tools

| Tool | Gesture | Output |
| --- | --- | --- |
| Pen | freehand | pressure-thinned perfect-freehand polygon |
| Highlighter | freehand | 4× width, `multiply` at 35 % |
| Line | drag | straight segment / vector |
| Axes | drag from the origin | coordinate plane |
| Stroke eraser | sweep | removes whole strokes |
| Pixel eraser | freehand | `destination-out` stroke |

Every ink tool shares the toolbar's **pattern** (solid, dashed, dotted,
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
toolbar row configures divisions per half-axis, the faint grid, numbered
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
├── InkingToolbar.tsx       tools, colour, width, Touch Draw, undo/redo/clear
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
