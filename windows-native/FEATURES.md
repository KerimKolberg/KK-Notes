# KK-Notes: everything the app does

The complete feature list of the current app (Tauri + React, `src/` and `src-tauri/`), for the
native Windows version to work through. Each line names where it lives; the README section of the
same name says how it works and why. Order within a group is roughly how much it is used.

Status column for the native app: `[ ]` not started, `[~]` partly, `[x]` done. Update it as you go.

## Writing and drawing

- [ ] **Pen** with five brushes: ballpoint, fountain pen, pencil (grain, tilt shading), marker, wet brush (`inking/engine/brushes.ts`)
- [ ] Pressure, tilt, speed-driven tapers; stroke outline like perfect-freehand (`engine/strokeOutline.ts`)
- [ ] Pen widths 0.25–24 px in notches, fine pens smooth less (README *Writing small, zoomed in*)
- [ ] Quick widths (two presets, hold to save the current width into one)
- [ ] Colours: swatch row, editable swatches, pipette (pick a colour from the page), custom colour
- [ ] Dashed/dotted patterns and arrowheads on strokes
- [ ] **Highlighter**: own width, opacity slider, multiply blend, rainbow / two-colour gradient
- [ ] **Washi tape**: patterned translucent band, own width/opacity, optional straighten
- [ ] **Shapes / line tool**: line, polyline, polygon, rectangle, ellipse, heart, curves (wave etc.), with its own pattern, arrows and snap
- [ ] **Hold to snap**: hold the pen still at the end of a stroke to turn it into a clean shape
- [ ] **Coordinate plane**: axes with grid, ticks, labels, custom step sizes
- [ ] Angle HUD while drawing lines
- [ ] **Eraser**: stroke eraser and area (pixel) eraser, eraser size, filters (only pen / highlighter / tape / shapes), "clear page"
- [ ] **Laser pointer**: fading trail (2.7 s), rainbow option, never saved
- [ ] **Ruler, protractor**, snap to grid (`engine/ruler.ts`, `protractor.ts`, `grid.ts`)
- [ ] **Zoom writing window**: write large in a box, lands small on the page
- [ ] Undo / redo of ink, and of page changes (add, delete, reorder, imports)
- [ ] Palm rejection, pen vs touch vs mouse policy (touch scrolls/zooms, pen draws)
- [ ] **Pen buttons**: barrel button and eraser end mapped to any tool, persisted; a held button's lasso keeps its selection

## Selecting and editing (lasso)

- [ ] **Lasso** loop or line-through; modes: enclose entirely / touch partly
- [ ] Layer filters: pen ink, highlighter, tape, shapes, images/notes/text
- [ ] Move, resize (edge handles, cross-page drag), rotate, duplicate, delete
- [ ] Recolour, change width, change pattern of the selection
- [ ] Group / ungroup, align, bring to front / send to back
- [ ] Edit a curve after drawing it
- [ ] Copy / paste, convert handwriting selection (search text)
- [ ] Auto-scroll when dragging a selection to the edge

## Pages and documents

- [ ] Pages: A4 default (794 × 1123 px), add before/after, duplicate, delete, reorder (page arranger with thumbnails); pick several pages (Ctrl/Shift-click, hold, typed list "2, 15, 20-25") to move, duplicate, delete or restyle together
- [ ] Templates: blank, ruled (margin line), grid, engineering, isometric; spacing slider; background colour
- [ ] Page defaults (template/colour for new notes) in settings
- [ ] View modes: vertical continuous, horizontal continuous, single page, double page
- [ ] Notebook cover
- [ ] Zoom: buttons, Ctrl+wheel, touchpad pinch, two-finger pinch; zoom keeps the centre; zoom settings (speed, threshold, step)
- [ ] Two-finger pan and navigation; page number / jump to page
- [ ] **Bookmarks** (name a page, list, jump)
- [ ] **Search in a note**: typed text, PDF text, recognised handwriting; Enter / Shift+Enter, highlights
- [ ] Note title (pen near the top of a page does not write into the title)
- [ ] Read-only **lock** for presenting
- [ ] Version history (snapshots, restore) (`notes-sync/src/history.rs`)
- [ ] Autosave drafts, "restored autosaved draft" with Discard
- [ ] Tabs: several notes open, parked in memory; **split view** with a read-only reference pane (zoom, swap sides and roles)

## Typed text

- [ ] **Keyboard button** (first on the toolbar): typing mode with its own text toolbar; pen button returns to the last tool
- [ ] **Page text** inside 1 cm margins that flows from page to page (adds pages), Ctrl+Enter page break
- [ ] **Click and Type**: click anywhere below the text to type there; position sets indent / centre / right
- [ ] **Text boxes** anywhere (on PDFs too), moved by a grip, lockable
- [ ] Formatting: bold, italic, underline, strikethrough, super/subscript, colour, highlight, font (sans/serif/mono), size; headings H1–H3; alignment incl. justify; indent; bullet, numbered and check lists; clear formatting
- [ ] Markdown-like shortcuts ("# ", "1. ", "[] "), keyboard shortcuts sheet (Ctrl+/)
- [ ] Text in front of or behind the drawings
- [ ] Word count (Ctrl+Shift+G), incl. recognised handwriting words

## PDF, images and media

- [ ] **Import PDF** (as pages, or open a PDF as a note), annotate on it
- [ ] PDF **forms**: fill text fields, checkboxes, radios, selects
- [ ] PDF **table of contents** panel, jump to chapters
- [ ] **Select PDF text**: copy, highlight
- [ ] **Export PDF** with ink, text, notes, tables burnt in; export `.notex`
- [ ] Images: paste, drop, insert; move, resize, crop/rotate, lock
- [ ] **Sticky notes** (rectangle, oval, speech bubble)
- [ ] **Tables** (table generator: rows, columns, header, styles)
- [ ] **Snipping tool**: snip a region of a reading pane / tab and drop it onto a page (pen, mouse, finger)
- [ ] Drop files on the app: PDF on a page opens beside it; images onto a page; notes open in tabs
- [ ] **GoodNotes import** (`.goodnotes`), with an import report
- [ ] **Audio recording** with the writing; playback that replays the ink in time, seek, speed, delete

## Handwriting

- [ ] Handwriting recognition with Windows' recogniser, saved with the note
- [ ] Search finds handwriting (in the note and across the library)

## Library (home screen)

- [ ] Folders and note cards (picture of page one), grid / list, sort by name / modified / created
- [ ] New note, new folder, open file, up / breadcrumbs, drag a note onto a folder
- [ ] **Search all notes** (typed text, titles, handwriting, text inside embedded PDFs)
- [ ] **Favourites and tags** with filter chips
- [ ] **Select** (button, right-click, press and hold, Ctrl/Shift-click, Ctrl+A): **copy**, **export** (PDF / .notex), **delete**
- [ ] **Recycle bin** (30 days): put back with stars/tags, delete for good, empty; Undo after delete
- [ ] Conflict dialog for sync conflicts

## Sync, safety, system

- [ ] **Google Drive sync** (OAuth PKCE sign-in, three-way sync, conflicts kept, deletes are trashes)
- [ ] **App passcode** lock (auto-lock)
- [ ] Open with / file associations (`.notex`, `.goodnotes`, `.pdf`), single instance
- [ ] Start with Windows, start in tray, close to tray, tray Quit saves drafts
- [ ] **Fullscreen** (F11): borderless or full screen, placed exactly
- [ ] Dark / light, safe areas on Android (Android stays on the Tauri app)

## The toolbar and settings

- [ ] Toolbar docked to any edge as a flush band, or free; pin / auto-hide; one sliding row or wrapping
- [ ] Arrange tool icons; per-tool settings flyouts (away from the edge)
- [ ] Pointer style over the page (small cross, crosshair, arrow)
- [ ] Low-latency ink switch (experimental)
- [ ] Settings reset; all preferences remembered
- [ ] Performance overlay (debug: frame times, input latency)
