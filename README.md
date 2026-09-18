# Notes: multi-page inking

A React + TypeScript notes app for 2-in-1 pen/touch laptops: a low-latency
inking engine (`src/inking/`) with palm rejection, pressure-sensitive strokes
via [perfect-freehand], STEM shape tools and hold-to-snap, hosted in a
multi-page document system (`src/document/`) behind a document library home
screen with folders and cross-device sync (`src/library/`,
`src-tauri/notes-sync/`), with procedural page templates,
canvas virtualisation, a Samsung Notes-style page arranger, a media layer of
images, sticky notes and tables, a lasso selection tool, two-finger pan / pinch-zoom navigation, a read-only
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
npm run test:rust      # the sync engine's own tests (no webview needed)
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
config, background colour, stroke arrays (freehand and geometric), the media
layer (images as data URLs, sticky notes, tables), AcroForm fields and
values, and PDF sources stored once as base64. Files written before notes and
tables existed carry an `images` array instead, which is migrated to `media`
on load. A bare serialized document (`.json`) is also accepted. Undo history
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

## Document library and sync (`src/library/`, `src-tauri/notes-sync/`)

The app opens on a **library**, not a document: folders and cards for
everything written, in a grid or a list, sorted by name, date modified or date
created. Opening a card routes to the document; *Back to library* in its top
bar routes back.

**Routing** is a three-line reducer (`routeStore.ts`) rather than a router
dependency, because there are exactly two views and one of them has no URL to
speak of. `nextRoute` is pure, so the navigation rules are tested without
mounting anything, and it returns the *same object* when nothing changes so a
no-op navigation cannot re-render the tree it was meant to leave alone. A
document remembers the folder it was opened from, so going back lands where it
started rather than at the root; *Home* goes to the root, which is the way out
of a library navigated deep into.

Leaving a document **releases it**. A document is the largest thing the app
holds — every page's strokes, every embedded image as a data URL, any imported
PDF — with decoded page bitmaps in the raster cache on top, and `ImageBitmap`
holds memory outside the JS heap, so dropping the reference is not enough.
`releaseDocument` resets the store and clears the cache, closing each bitmap.
The two views are swapped rather than both kept mounted behind a CSS toggle,
for the same reason.

**Thumbnails come out of the file, not out of the document.** A library of a
hundred notebooks cannot parse a hundred documents to draw a hundred cards.
`notes-sync`'s `read_thumbnail_source` deserialises a `.notex` straight into a
struct that keeps page one: `serde_json` reading into typed structs is a
streaming parser, so the fields the target does not declare — the other pages,
and `pdfSources`, which carries whole imported PDFs as base64 and is routinely
the largest thing in the file — are consumed as `IgnoredAny`, advancing over
the tokens without building a value. A custom `FirstOf<T>` visitor does the
same for the pages array. The file is read once and the peak retained memory
is one page. The frontend then hydrates that page alone and rasterises it with
the same renderer the page snapshots use, and only for cards actually on
screen (an `IntersectionObserver` gates the work). A page that references a
PDF is drawn without it: fetching the source to fill a 200 px card would undo
the whole point.

**Folders** are real directories and filing a note is a real move — drag a
card onto a folder. Nothing overwrites: a name already taken gets a numbered
suffix, because dragging a file onto a folder is not a request to destroy
what was already called that. Every path from the frontend is checked against
the library root before it is used, since one `..` in a folder name is all it
takes to write somewhere else by accident.

### The sync engine

`src-tauri/notes-sync/` is a workspace crate with **no Tauri dependency**. The
shell cannot be compiled — let alone tested — without a platform webview, and
none of this needs one, so `npm run test:rust` runs the engine's 54 tests
anywhere. The Tauri side (`library_commands.rs`) is a thin IPC surface over it.

**Watching.** A `notify` watcher over the library feeds a thread that waits
for a burst to settle before reporting: an atomic save is a create, a write, a
flush and a rename — four events for one edit — and the autosave fires every
1.5 s while someone is writing. Temp files and hidden files are filtered out,
so a half-written document is never uploaded. Watching is best-effort by
nature — every backend has a window where a file created inside a directory
that was itself just created is missed, and inotify drops events when its
queue overflows — so it is an optimisation that makes sync feel immediate,
never the only trigger: the library asks for a pass when it opens, which
reconciles anything missed.

**Deciding** is three-way, not two. Comparing local against remote only says
*that* they differ, never which way to move: a file edited here looks exactly
like a file edited there. What distinguishes them is the digest recorded at
the last successful sync — the base. Against that, one side having moved means
copy it over, both sides having moved to the same content means agree on a new
base, and both having moved differently means ask. A two-way comparison is how
sync tools silently eat a page of notes. Decisions are made on SHA-256 of the
content, never on timestamps: a clock that runs fast, a tool that preserves
mtimes, a cloud client that rewrites a file byte for byte, all produce
timestamps that say "changed" about a file that did not.

**Conflicts stop the engine** rather than being guessed. Both copies are left
exactly as they are and the frontend shows a modal. *Keep both* leads, because
it is the only one of the three answers that cannot throw away work: the
incoming copy lands beside the local one as `Week 1 (conflicted copy from
<device>).notex` — the device name is there because the point of keeping both
is being able to tell them apart afterwards, and "copy 2" does not — and is
uploaded too, so both devices end up holding both versions. A deletion on one
side and an edit on the other is a conflict as well; deleting someone's edit
without asking is the one thing a sync engine must never do.

**`CloudProvider`** is the seam a real backend plugs into. Nothing in the
crate talks to a network; the trait is deliberately the intersection of WebDAV
(`PROPFIND`, `GET`, `PUT`, `DELETE`) and Google Drive (`files.list`,
`files.get`, `files.create`, `files.update`) — a flat listing keyed by relative
path, whole-file get and put, delete — so adding one is a new implementation
rather than a rewrite. Drive's file ids and WebDAV's collections are each
provider's own problem. Until an account is connected, `OfflineProvider`
refuses every operation rather than pretending one succeeded, and the status
pill reads *Offline*, which is a truthful state and not an error.

The status pill in the library's top bar shows Offline / Syncing / Up to date
/ Needs attention, pushed from Rust over a `sync://status` event after each
pass rather than polled.

**In a browser** there is no filesystem and no Rust, so `browserLibrary.ts`
keeps the same interface over `localStorage` — otherwise `npm run dev` would
be useless for working on the library itself. It is a fallback, not a second
product: there is no sync, the status stays `offline` truthfully, and a
`localStorage` quota failure is surfaced rather than swallowed.

## Document system (`src/document/`)

**State.** A Zustand store (`store.ts`) owns the `Document` (pages, active
index, view mode, zoom), a `scrollRequest` counter that asks the viewer to
scroll, the arranger's open state, the read-only lock, and the media /
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
groups the tools (select, lasso, laser, add · pen, highlighter, washi tape ·
line, coordinate system, stroke options · eraser · settings) and the second
carries the colour swatches and the thickness slider. Tools that have more
to say open a flyout when their own button is pressed again: the lasso's
layers and mode, the pen's five brushes, the highlighter's width, opacity and
gradient, the tape's patterns, the shape tool's paths and dashes, the
coordinate plane's quadrants, steps and labels. The eraser is one button with
two modes, the pattern / stylus / diagnostics settings each live behind a
popover, and everything the old text toolbar could do is still there. The
settings popover is also where *Debug mode* opens the performance overlay
(below).

**Each tool's settings are its own.** The shape tool used to share the dash
pattern, arrowheads and 15° snapping with the pen and the highlighter, which
meant dashing a construction line also dashed the next pen stroke — two
different jobs reading one field. It keeps `linePattern`, `lineArrowheads`
and `lineAngleSnap` now, alongside the curve settings (`lineCurve`,
`curveAmplitude`, `curveCycles`, `curveFlip`) that were already its alone;
the shared `pattern` / `arrowheads` / `angleSnap` belong to the freehand
tools, and the stroke-options popover says so rather than sitting there
greyed out with no explanation.

Everything that can be *placed* on a page — an image, a sticky note, a table
— sits behind one **Add** button rather than three of its own, because they
are one errand with three answers and the palette has no room to spend on
each. The popover's body is passed into `ToolPalette` as a render prop
(`insertMenu`), so the palette stays an inking control that knows nothing
about pages, notes or tables.

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

**Lasso tool** (`src/inking/engine/lasso.ts`, `lassoFilter.ts`,
`SelectionLayer.tsx`). The `lasso` tool mode draws a freehand loop on the
live canvas (pen or mouse). A stroke's *sample points* are the raw samples of
a freehand stroke, or points spread evenly along the flattened outline of a
geometric shape, so the verdict reflects how much of the outline is caught
rather than how many corners happen to be.

Containment is **non-zero winding**, not the even–odd rule, and the loop is
always closed by joining the last sample back to the first — the edge the
user never draws, because they lift the pen where they lift it. Winding is
what makes backtracking work: under even–odd, a loop that crosses its own
path carves the overlap back out again, so running the stroke a little past
where you began silently drops whatever is in that sliver. The two rules
agree exactly on any loop that does not cross itself, so nothing about a
careful lasso changes. Pressing the lasso button again
opens what it is hunting for — the layers and the mode below. The selection
(`lassoSelection` in the store: page id + stroke ids) shows up as a dashed
box on a z-25 layer between the ink and the form widgets:

- **drag the box** to translate, **drag a corner handle** to scale about the
  opposite corner (uniform by default, Shift for free aspect; line widths
  scale with the geometric mean of the axes);
- **quick actions**: Duplicate (offset copies become the new selection),
  six colour swatches plus a colour picker, a width slider that previews
  live and commits on release, Delete, Deselect; Delete / Backspace and
  Escape work from the keyboard;
- **curve settings**, when the selection holds a line or a curve: the four
  paths (straight / parabola / wave / zigzag), the dash pattern, a depth
  slider, Flip and a cycle count.

**What the loop catches** is two settings. *Enclose entirely* wants
substantially the whole stroke: at least **85%** of its sample points inside
the polygon. Not 100% — a lasso is drawn by hand around ink that has width,
and the failure mode of a hard rule is brutal: loop a word, clip the tail of
one descender by two pixels, and the whole word is left behind with nothing
to say why. At 85% a near miss is forgiven while a stroke merely straddling
the edge is still refused. The bounding box is only a cheap overlap reject
now; it used to have to be *contained*, which meant the halo of padding
around a thick stroke — half its width, plus any arrowhead — could veto a
stroke whose every sample was well inside the loop. *Partial touch* takes
anything
the loop so much as crosses, which makes a stroke dragged straight through a
diagram a valid selection gesture — far quicker on a phone, where drawing an
accurate loop around something small is the hard part. It qualifies two ways,
because neither covers the other: a sample point inside the loop catches a
small stroke swallowed whole by a big one, and a segment crossing catches a
big shape a small loop was dragged across, where every sample of the shape is
outside the loop and only the segments give it away. Crossings use the usual
orientation test, with the collinear and touching-endpoint cases settled
rather than swept under an epsilon — a lasso drawn exactly along a ruled line
is a real gesture.

**Which layers it may take** is four switches: standard ink (pen), the
highlighter, washi tape, and shapes / lines. Deliberately the opposite
polarity to the eraser's filter, where all off means "take everything":
here every layer starts checked and unchecking one puts it out of reach,
which is what a *selection* filter has to mean if "the writing but not the
highlighting I drew over it" is to be expressible. Clearing all four leaves
the lasso with nothing to find, which the popover says outright rather than
quietly re-including a layer that was just switched off. Pixel-eraser strokes
are never selectable under any setting: selecting one would hand the user a
hole to drag around.

While a drag is in flight the originals are hidden on the committed layer
(`hiddenStrokeIds`) and transformed copies are drawn on the selection
layer's own canvas, so nothing is written to the store until the pointer
lifts. Every commit (`transformSelection`, `restyleSelection`,
`duplicateSelection`, `deleteSelection`) replaces the page's stroke array
through `withStrokes`, i.e. it is exactly one entry on that page's undo
stack. Transforms keep stroke ids, so a selection stays valid across undo /
redo of its own edits; a new lasso, or switching to any tool other than
Lasso / Select, clears it.

**Editing a curve after the fact.** A `CurveShape` keeps everything it was
drawn from — both ends, a *signed* amplitude and a cycle count — so nothing
extra had to be stored to make a committed curve editable again.
`curveParams()` (in `shapes.ts`) takes one apart: depth comes back as the
amplitude measured against the chord, and the sign of the amplitude *is* the
flip. `reshapeCurve()` merges the toolbar's changes over that and rebuilds
the shape, keeping the endpoints fixed; a straight line has no depth of its
own, so it borrows the tool defaults until the sliders are moved, and
straightening is the same edit in reverse. `reshapeStrokes()` applies it to a
selection and recomputes each bbox, and `reshapeSelection` in the store
commits it as one undo entry — the depth slider previews on the selection
layer's own canvas while it moves and only commits on release, so dragging it
leaves one entry rather than forty.

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
./build-android.sh --abi aarch64       # …for one architecture only (see below)
npm run tauri android build -- --apk   # the same release build, straight from the CLI
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

By default the APK carries all four Android ABIs, which is what you want for
something handed to unknown devices. It also means four Rust cross-compiles
and, for a debug build with unstripped binaries, about 135 MB. `--abi aarch64`
builds just the one architecture every phone and tablet of the last several
years actually uses, which is roughly a third of the size and a quarter of the
compiling — the CI workflow uses it for exactly that reason. The APK then
lands under `apk/arm64/` rather than `apk/universal/`.

A release APK is **unsigned**: `zipalign` and `apksigner` it with your own
keystore before installing it anywhere.

### What is committed, and what is generated

`src-tauri/gen/android/` is in the repository so the Android project can be
reviewed and diffed. Three kinds of files live there:

- **Tauri's template** — Gradle wrapper, `buildSrc/build.gradle.kts` (registers
  the `rust` Gradle plugin), resources.
- **This project's customizations** — the manifest permissions, the SDK
  levels, and `MainActivity.kt`. `tauri android init` regenerates the
  template and would overwrite them, so they are applied by
  `scripts/android-customize.mjs`, which is idempotent, runs from
  `build-android.sh` after an init, and doubles as a checker
  (`npm run check:android`) that also scans every Android resource for
  malformed XML.
- **Machine-specific files** (`tauri.settings.gradle`, `tauri.build.gradle.kts`,
  `tauri.properties`, `jniLibs/`, the bundled `tauri.conf.json`, and the
  `rust` Gradle plugin's own classes under `buildSrc/src/main/java/…/kotlin/`
  — `BuildTask.kt` / `RustPlugin.kt`) — generated by `tauri android init` on
  whatever machine builds the project, and git-ignored, because they contain
  absolute paths into the local Cargo registry. `build-android.sh` runs
  `init` automatically on a fresh checkout whenever these are missing, which
  is why CI needs no separate setup step for them. (An earlier version of
  this repo committed a stale, wrongly-pathed copy of the two `.kt` files,
  which broke the Kotlin build with duplicate-declaration errors —
  `buildSrc/.gitignore` and the `--check` guard now keep that from coming
  back.)

`src-tauri/tauri.android.conf.json` holds the Android-only configuration
overrides; Tauri merges it on top of `tauri.conf.json` automatically for
mobile builds.

### Open with, and writing files

Android's Storage Access Framework does not hand back a filesystem path. The
save dialog returns a `content://` URI whose bytes are reachable only through
the platform's ContentResolver, and everything that treats it as a path —
`std::fs`, and the temp-file-plus-rename the native writer uses — either fails
or quietly creates a file *named* after the URI. That is what made every PDF
exported on the device unopenable. `writeBinary` now routes a content URI
through the fs plugin (`writeFile`, which takes a `Uint8Array`, so the bytes
stay bytes) and a real path through the native command, which sends them as
the raw IPC body — no base64, no array-of-numbers JSON — and writes them
atomically. `.notex` saves take the same fork, and `atomic_write` refuses a
content URI outright rather than writing nonsense, so a regression is loud.
The `.pdf` extension on the suggested name and the dialog filter is what
Android turns into the intent's `application/pdf` MIME; without it the file is
created as `application/octet-stream` and nothing offers to open it.

**"Open with"** needs two intent filters, not one. `ACTION_VIEW` with
`android:mimeType="application/pdf"` covers a sender that knows what it is
holding; the extension-matching filter below it covers the ones that hand over
a `content://` URI typed `application/octet-stream`, which is common. The
`pathPattern` escapes its own dot, or it would match any character before
`pdf`. `.notex` gets the same treatment, since the app is the only thing that
can open one.

The intent itself never reaches the process as an argument, so `MainActivity`
catches it and exposes it through a bridge object — the same pull-then-push
shape as the insets, and for the same reason: a JavaScript interface added to
a WebView is only visible to the *next* navigation, so the page asks rather
than waiting to be told. It is consumed on read, because opening the app a
week later must not re-import the PDF someone opened once.

Launched from a PDF, the app skips the library: it creates a new document with
the PDF's pages imported at their own size and opens straight into it. Someone
who tapped "open with" on a PDF wants to write on it, not to be shown a file
list. Classification trusts the extension over the declared MIME type, and
falls back to the MIME when a `content://` URI has no visible name at all.

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

**Note shapes.** A sticky note is a rectangle, an oval or a speech bubble.
The card is drawn as an absolutely-placed body *inside* the object's box
rather than as the box itself, so a shape that does not fill its box — a
bubble, whose tail hangs below the body — still leaves one rectangle for the
transform handles to work with. The outline is CSS: a border radius for the
rectangle and the oval, a clipped triangle for the tail.

The textarea is placed at the shape's own text box rather than filling the
card, which is what keeps a line of text from running out through the curve
of an oval: for an ellipse that box is the *inscribed rectangle* — half the
ellipse's size times √2, the largest axis-aligned box that fits inside it —
so an oval note holds noticeably less than the rectangle of the same
footprint, and anything roomier would clip mid-word at the sides. A bubble's
text stops above the tail and inside the corner radius. The drag lip across
the top belongs to the rectangle alone: a full-width bar clipped to an
ellipse comes out as a lens-shaped sliver and reads as a rendering bug, and
the other two are dragged by the grip every placed object carries anyway.
One set of helpers in `media.ts` (`noteBodyBox`, `noteTailPoints`,
`noteTextLocalBox`) drives the live card, the snapshot raster and the PDF
export, so all three wrap the text identically.

**Media** (`media.ts`, `MediaLayer.tsx`, `useMediaInput.ts`). Paste
(`Ctrl+V`) or drop images onto a page (dropped PDFs import), or place an
image, a sticky note or a table from the palette's Add menu. All three share
one box — `{x, y, width, height, rotation, zIndex, locked?}` — and one
transform box: eight resize handles (aspect locked by default for an image and
free for a note or a table, Shift swaps the two, anchored on the opposite edge
so rotated boxes resize predictably), a rotation handle (Shift snaps to 15°),
body drag, and a contextual toolbar / right-click for Lock, Delete, Bring to
front and Send to back. `Delete` removes the selection. A locked object still
selects — that is how it gets unlocked — but shows no grips at all, because
nothing to grab is the clearest statement that nothing will move.

Notes and tables are real HTML rather than canvas, because they are typed
into and need the platform's own text editing, selection and IME. That makes
them hard to *pick up*: every cell and textarea swallows the press that was
meant for the object. So each one carries two extra affordances (`MediaGrips`):
a grip bar at the top centre, a constant size on screen like the resize
handles, and — until the object is selected — a shield over its whole box, so
the first press anywhere takes hold of the table and the second, once it is
selected, types into a cell. Both ride the object's own rotation. Ink always
wins over media regardless: the media layer is z-10 against the ink layer's
z-20, and goes `pointer-events: none` entirely whenever the current tool is
not Select.

A **table** is configured before it exists — a grid picker up to 20 × 20, and
grid line width and opacity — because picking the size afterwards would mean
adding rows one at a time, and how hard the ruling is printed is part of what
a table is for. Its column and row shares live on the object
(`columnFractions` / `rowFractions`, summing to 1), so dragging an internal
divider is a document edit rather than a view state that evaporates on
reload; `resizeTrack` moves only the two tracks either side of the divider,
the way a spreadsheet does, and neither may collapse past
`MIN_TRACK_FRACTION`. Adding or removing a row keeps the layout by rescaling
the shares rather than resetting them, and a file written before dividers
existed — or one whose stored list no longer fits the grid — falls back to an
even division. The same fractions drive the live grid, the page snapshot
raster and the PDF export, so all three land on identical lines.

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
pages), highlighter uses the Multiply blend (a gradient one is chopped into
flat-coloured pieces, since the op vocabulary has no shading), and coordinate
planes become lines, arrowheads and text. The pixel eraser cannot be represented as vectors
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
| Lasso | freehand loop, or a line through something | selects by layer and mode (see above) |
| Pen | freehand | pressure-thinned perfect-freehand polygon |
| Highlighter | freehand | constant width, `multiply`, opacity and gradient from its own popover |
| Washi tape | freehand | wide translucent band filled with a repeating pattern |
| Laser | freehand | glowing trail that fades out in 2.7 s, never committed |

The pen's **brush** picker chooses between ballpoint, fountain pen, pencil,
marker and wet brush (see the brush engine above).
| Line | drag | straight segment / vector |
| Axes | drag from the origin | coordinate plane |
| Stroke eraser | sweep | removes whole strokes it crosses |
| Area eraser | freehand | `destination-out` band, at its own size |

**The highlighter** carries its own width rather than borrowing the shared
thickness slider: it is tens of pixels wide where a pen is a few, and one
range serving both would leave each end of it useless. Opacity and the
gradient live beside it, behind a second press of its button.

*Gradient* is off (one flat colour), **Rainbow** (a full hue sweep) or **Two
colours** (the stroke colour fading into a second one). Either is mapped
across the *finished stroke's bounding box*, along whichever axis it is
longer in, so a stroke that doubles back on itself still reads as one sweep
end to end rather than restarting on each wobble. On a canvas that is a
`createLinearGradient` used as the fill; PDF has no shading in the op
vocabulary used here, so the export chops the centreline into sixteen
flat-coloured pieces with a vertex of overlap — round caps hide the joins,
and at that many pieces the banding is below what the eye picks up at
reading size.

**Washi tape** is a strip, not a stroke: constant width, no pressure
response, and its pattern (solid, stripes, checks, dots) frozen onto the
stroke so it re-renders at any zoom and survives an export. *Straighten
lines* runs an aggressive RDP pass over the path, which turns a wobbly drag
into the straight strip a roll of tape actually produces — **once, when the
pen lifts**. It used to run inside the renderer, which meant re-simplifying
the whole path on every animation frame of the drag: work that grows
super-linearly with the stroke (measured here at 0.07 ms for a 200-point
path and 4.3 ms at 2400, per frame) on the thread that owes the next frame.
On a desktop that is survivable; on a tablet CPU it is the reported stutter,
getting worse the longer the strip. `StrokeBuilder.build` straightens and the
committed path is what everything downstream reads, so the preview is now as
cheap as any other stroke and nothing re-derives the geometry. On a canvas the
pattern is a `createPattern` tile clipped to the band; a PDF has no such
fill, so the same tile is emitted as explicit marks placed wholly inside the
band's outline.

**The eraser** is one palette button. Pressing it selects whichever of the two
erasers was last chosen; pressing it again opens everything else it can do:
the mode (stroke or area), the area eraser's own size, the filters, and the
bulk removals.

The size belongs to the **area** eraser alone. The stroke eraser has a fixed,
small hit radius, because it lifts whole strokes: its size is a *precision*,
not a width, and a wide one takes the neighbouring line as well and feels
like it is guessing. Sharing one slider made the stroke eraser unusable the
moment the area eraser had been set wide.

*Only erase* narrows both erasers to the highlighter layer, the washi tape
layer, or both. The two are independent switches rather than a three-way
choice, so "highlighter and tape, but not my writing" is expressible. With a
filter on, everything else is passed straight over, ordinary pen strokes and
geometry included.

One caveat, visible in the flyout: a narrowed **area** eraser lifts whole
matching strokes rather than cutting them. `destination-out` takes whatever
is beneath it on the shared canvas and cannot be told to spare one ink type,
so the filter is honoured by hit-testing instead. Unfiltered, the area eraser
cuts pixels exactly as before.

The same filter scopes the two bulk removals, *clear this page* and *clear
every page*; both leave images, notes and tables alone, and the document-wide
one pushes one undo entry per page, so any page is a single undo from where
it was.

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

**Step size** (`stepX` / `stepY`) is what one grid cell is *worth*, kept
apart from the pixels-per-cell the extents give it: changing it renumbers the
plane without redrawing a line of it. Each axis carries its own, whole or
fractional, so a plane can read in tenths across and hundreds up. A tick's
text is `index × step` — which is exactly the arithmetic binary floating
point is worst at, since three steps of 0.1 lands on 0.30000000000000004 and
a plane labelled that way is unusable. `formatTickValue` rounds through
`toPrecision(12)` and back: twelve significant figures is far more than any
step a person types and far fewer than the seventeen it takes to expose the
representation, and `parseFloat` then strips the zeros `toPrecision` leaves
behind. A plane saved before steps existed carries neither field and counts
in whole cells.

## Customisation (`src/preferences/`)

Three things belong to the install rather than to a document, so they live in
their own store and are written straight to `localStorage`: the palette you
arranged should be the palette you get tomorrow, on whichever notebook you
open.

- **Palette order.** *Arrange icons* in the settings popover turns each tool
  button into a drag handle (the same pointer-reorder hook the page arranger
  uses, so pen, mouse and touch all work). It is a mode rather than an
  always-on drag because the palette floats over a canvas someone is drawing
  on, and a tool button that moved because the pen slipped would be worse
  than one in the wrong place. Dividers are drawn before the slot that starts
  each group, so the grouping survives a reorder instead of being pinned to
  fixed positions.
- **Quick colours.** Hold a swatch (or right-click it) to change it, with Add
  and Remove beside the picker. A hold rather than a click, so the row stays a
  row of colours for the pen; a press that became a hold does not also select
  the colour it was editing.
- **Page defaults.** *Set as default* in the arranger stores the selected
  page's template, spacing and background, and new notes start that way.
  `createPage` asks for them through an injected callback rather than
  importing the store — pages are created from a dozen places and threading a
  preference through each one means each one can forget it — and an explicit
  template always wins, so a PDF import is still a PDF page.

*Reset to defaults*, also in the settings popover, clears all three at once
and says so. Everything read back off disk goes through `normalize`: this is
user-editable storage that survives upgrades, so a slot that no longer exists,
a colour that is not a colour, or a list that lost half its entries has to
leave the app usable. A saved order missing a tool that did not exist when it
was written *gains* that tool at its default position rather than hiding it,
which is what keeps a future version from shipping an invisible feature.

## Performance overlay (`src/debug/`)

*Debug mode* in the settings popover opens a corner read-out of what the
inking pipeline is actually costing. It starts on in a development build and
off in a shipped one, and the toggle switches it either way: a dev-only
overlay with no off switch is in the way the moment you want to see what is
underneath it, and a production build that can never show one is no use when
a report says "it lags on my tablet".

Three numbers matter on a pen device, and none of them is visible from a
profile taken after the fact:

- **Frame rate**, counted from `requestAnimationFrame` — the only honest
  measure of whether the app is keeping up with the display.
- **Ink latency**: how long a pointer sample takes to become pixels. This is
  what a person feels as the pen "lagging behind the nib", and it is *not*
  the frame rate — a steady 60 fps with two frames of buffering feels worse
  than a jittery 50 with none.
- **React commit duration** per boundary, to catch a state update blocking
  the main thread between a pointer event and the frame it should have
  produced.

**Measuring the latency.** `onPointerMove` hands the profiler the timestamp
of the *newest* coalesced sample, and the live canvas's animation frame
closes the measurement once its last `fill` / `stroke` call returns. Three
choices worth knowing about:

- The newest sample, not the batch. A 240 Hz pen delivers four samples per
  60 Hz frame; the frame shows where the pen is *now*, so averaging in the
  older ones would flatter the number.
- `PointerEvent.timeStamp` shares its time origin with `performance.now()`
  and, for a coalesced sample, is when the digitiser reported the point — so
  this measures from the hardware, not from when the main thread got round to
  the event. A delta that comes out negative or implausibly large is a clock
  that does not share that origin, or a frame drawn for something other than
  that input (a laser trail fading out); either is discarded rather than
  averaged in.
- It ends when the JS call returns, not when the pixels light up. The GPU
  work after `fill()` is not observable from here, and forcing it to be — by
  reading a pixel back — would stall the pipeline and change the number it
  was trying to report. So this is main-thread latency, which is the part the
  app controls.

Both the mean and the p95 are shown, because a mean of 8 ms hides a stutter
that a p95 of 40 ms does not. `RollingWindow` keeps them: a fixed-capacity
ring over a pre-sized `Float64Array`, so pushing from a pointer handler at
240 Hz allocates nothing and cannot itself become the thing that drops
frames. The mean is a running sum with the evicted value subtracted — O(1) to
read — re-summed from the buffer once per wrap, because a sum that is only
ever added to and subtracted from drifts as rounding errors accumulate, and a
latency read-out that slowly diverges from the truth is worse than none. The
maximum and the percentiles are computed on read instead, since they are read
a few times a second and written thousands of times.

**Costing nothing when off.** `profilingEnabled()` is a module-level `let`,
and every entry point returns on it before reading a clock — timing every
frame in order to find out whether frames are slow would be its own answer.
The frame loop only runs while the overlay is open, and the overlay itself
repaints four times a second rather than per frame, since one that cost a
frame to draw would be measuring itself. It is `pointer-events: none`
throughout, so it can never swallow a stroke aimed at the page underneath it.

**React tracking.** `<RenderProfiler>` wraps `InkSurface` and
`DocumentViewer`, and any commit over 16 ms is counted and logged with the
boundary that produced it. The boundary is always mounted rather than
conditional: switching a `<Profiler>` in and out changes the element type at
that position, so React would tear down and rebuild everything inside it,
losing the canvases, the scroll position and any stroke in progress every
time debug mode was toggled. Keeping it and making its callback inert costs
nothing measurable. React only supplies commit timings from a development (or
profiling) build, so in a plain production bundle that panel stays empty
while the frame rate and latency — measured without React's help — keep
working.

It earned its keep immediately. `DocumentApp` reads the whole tool-settings
object, so moving a slider inside a popover re-renders it; `DocumentViewer`
was not memoised, so that re-ran the entire page strip — laying out every
page and re-deriving the visible ranges — for a value the canvas reads
through a ref and never from props. And `layoutInput` built `[singlePage]`
inline, handing the layout memo a new array on every render and busting it
even when nothing had moved. Both are fixed;
`src/document/__tests__/renderBoundaries.test.ts` guards the memo chain from
the app shell down to the ink, and the overlay's per-boundary commit counts
are how it is confirmed against a running app.

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
│   └── parts.tsx           brush, highlighter, tape, line, eraser, plane, settings panels
├── InkingCanvas.module.css
├── types.ts                Stroke, StrokeStyle, ToolSettings, HistoryEntry, …
├── constants.ts
├── engine/                 framework-free, unit-tested core
│   ├── strokeOutline.ts    perfect-freehand integration → Path2D
│   ├── renderer.ts         fills vs. stroked paths, dashes, arrowheads, plane, HUD
│   ├── shapes.ts           primitives, drag construction, curve editing, plane layout and numbering
│   ├── shapeRecognition.ts hold-to-snap classifier (RDP, PCA ellipse, corners, heart)
│   ├── simplify.ts         Ramer–Douglas–Peucker, arc-length resampling, tangents
│   ├── angles.ts           15° snapping, math-convention read-outs
│   ├── angleHud.ts         connected / intersecting angle arcs
│   ├── hitTest.ts          stroke-eraser geometry for both stroke kinds
│   ├── history.ts          undo/redo reducer
│   ├── pointerPolicy.ts    palm rejection, pressure, button mapping
│   ├── lasso.ts            selection modes, stroke transforms, reshaping, handle geometry
│   ├── lassoFilter.ts      which layers the lasso may pick up
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

src/debug/
├── rollingWindow.ts        allocation-free ring window: mean, max, percentiles
├── profiler.ts             fps, ink latency, draw time, React commits; inert when off
├── DebugOverlay.tsx        the corner read-out
└── RenderProfiler.tsx      always-mounted <Profiler> boundary

src/preferences/
├── types.ts                palette slots, page defaults, the shapes
├── store.ts                persisted store + normalisation of anything stored
└── usePageDefaultsSource.ts  lets createPage see the preferred layout

src/library/
├── routeStore.ts           pure route reducer + the store that releases a document
├── useBoot.ts              file association / draft restore decides the first view
├── libraryService.ts       one interface over the Tauri IPC and the browser fallback
├── browserLibrary.ts       localStorage library for the web build
├── sorting.ts              the ordering, mirroring notes-sync's
├── thumbnail.ts            first page → card image, without the document
├── LibraryView.tsx         grid / list, folders, sorting, sync status
├── DocumentCard.tsx        lazily rendered card, drag to file
├── SyncIndicator.tsx       Offline / Syncing / Up to date / Needs attention
└── ConflictDialog.tsx      keep local, keep remote, keep both

src-tauri/notes-sync/src/
├── digest.rs               SHA-256 content fingerprints
├── library.rs              listing, sorting, folders, path containment
├── thumb.rs                streaming first-page extraction
├── conflict.rs             the three-way decision and conflict naming
├── provider.rs             the CloudProvider trait (WebDAV / Drive shaped)
└── manager.rs              notify watcher, passes, conflict resolution
```

[perfect-freehand]: https://github.com/steveruizok/perfect-freehand
