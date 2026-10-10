# KK-Notes for Windows, native (WinUI 3)

This is **step 1 of [HANDOFF.md](HANDOFF.md): the pen prototype**. It is not the app. It is one window with
one A4 page and a pen, built to answer a single question on the owner's ROG Flow Z13: does native ink
feel clearly better than the current app's? Nothing more gets built until that answer is in.

## Building and running

Needs the .NET SDK (9 is installed; .NET 8 and 9 both leave support on 10 November 2026, so moving to
.NET 10 is due soon). Visual Studio's *WinUI application development* workload is installed. Its templates
are not used: the project files are written by hand, which is all the template would do. The app is
**unpackaged**, so it needs neither signing nor Developer Mode.

```powershell
dotnet build windows-native\KKNotes.Native.sln -c Debug -p:Platform=x64
dotnet test  windows-native\KKNotes.Core.Tests
windows-native\KKNotes.Native\bin\x64\Debug\net9.0-windows10.0.22621.0\KKNotes.Native.exe
```

- **The log** is `%TEMP%\KKNotes.Native.log`, started afresh at each launch. It records what was set up
  (the display's refresh rate and scale, the input thread, the frame latency, the system's prediction
  time, the swap chain) and every error. Each stroke adds one line: how many samples arrived and how fast
  (a pen on the Z13 should report a few hundred a second), how many were kept, and how many moves had
  a prediction. Read it first when something is wrong.
- **`KKNotes.Native.exe --snapshot page.png`** draws a demo page (one stroke of each kind), saves it and
  quits. It checks the drawing code without anyone at the screen. Add `--demo small` for synthetic
  small handwriting at a high zoom, drawn the old way and the zoom-aware way.

## What it does

| | |
| --- | --- |
| **Pen** | Draws with the chosen tool. The **eraser end** erases. The **barrel button**, as in the current app: a click (under 300 ms) toggles pen ⇄ eraser, a hold borrows the eraser until it is let go, and a stroke made with it held erases. |
| **Touch** | Never draws. One finger pans, two pinch to zoom, both with inertia. While the pen is in range, and for 700 ms after it was last seen, a finger is taken for a palm and ignored. |
| **Mouse** | The left button draws, the middle button pans. The wheel scrolls, Shift+wheel scrolls sideways, Ctrl+wheel zooms. |
| **Tools** | Ballpoint (the current app's default pen), fountain pen (follows pressure and tilt), highlighter, stroke eraser. The current app's eight colours; widths 0.5–8 (pen; half a unit is for writing small zoomed in) and 8–32 (highlighter). |
| **Keys** | Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo, Ctrl+0 fit the page, F11 full screen, Esc leaves it. |
| **Measuring** | A line under the toolbar shows the refresh rate, frames/s, pen samples/s, the input age at present, the draw time and the pen's live state (tip/hover, barrel, eraser, pressure, tilt): that is the *pen button test*. |
| **Experiments** | The toolbar switches the prediction (system default, off, 10/20/30 ms), the present mode (at once, or on v-sync), and *Zoom-aware* ink (on by default; off draws new strokes as the current app does). |

## How the ink is drawn, and why

**There is no `InkCanvas` in WinUI 3.** The handoff's first choice was `InkCanvas` / `InkPresenter`. The
Windows App SDK used here (2.5.1, WinUI 2.3.9) still has neither: its metadata was searched for them.
So the prototype takes the second road, the same one Windows Ink takes inside:

- **The pen arrives on its own thread.** `SwapChainPanel.CreateCoreIndependentInputSource` is called on a
  dedicated `DispatcherQueue` thread. Pen, mouse and touch events then never wait behind layout, the
  toolbar or anything else on the UI thread. Each move event hands over **every sample** the digitiser
  reported since the last one (`GetIntermediatePoints`), oldest first.
- **Prediction.** `PointerPredictor` (Windows App SDK) says where the pen is heading. Its default here is
  15 ms. The predicted points go on the end of the stroke being drawn, are redrawn from the real samples
  on the next event, and are never saved. Overshoot at sharp turns is the price. The toolbar can turn it
  off or change it, to find what feels best. **When it has no prediction it returns null, not an empty
  list.** In the first test on the Z13 it did that on most moves. The code went over that null
  unchecked, the exception took the move's real samples with it, and strokes kept little more than
  where the pen landed and lifted: straight lines and unreadable writing. Now a move without a
  prediction is simply drawn without one, and every pointer handler is guarded, so a failure is logged
  and counted in the measurement line instead of silently losing ink.
- **No queue of frames.** DXGI lets the CPU run up to **three frames** ahead of the screen by default, and
  each queued frame is a frame of lag. Win2D does not expose this, so `Interop/Win32.cs` sets
  `IDXGIDevice1::SetMaximumFrameLatency(1)` on Win2D's device directly. The log says whether it took.
- **A frame as soon as there is something to show.** The render thread sleeps until input arrives,
  draws, and presents at once (sync interval 0). DWM puts the newest finished frame on screen at its next
  refresh, so a sample waits at most for one frame to be drawn, never for a refresh to come round first.
  *Present on v-sync* is there to compare against.
- **Nothing over the ink.** The toolbar and the measurement line sit above the drawing area, not over it.
  A swap chain that nothing overlaps can be given its own hardware overlay plane, which saves the
  compositor's frame. In the browser that was the trouble: a canvas on an overlay plane broke on this
  very tablet as soon as something translucent covered it (README, *Low-latency ink*).
- **Dry and wet.** Finished strokes live in a bitmap the size of the view. It is redrawn only when the
  page moves or the strokes change, and a new stroke is drawn onto it rather than redrawing everything.
  Each frame copies that bitmap, then outlines and fills the stroke in progress (plus prediction), so
  the cost of a frame does not grow with the page. The draw time is in the measurement line. The stroke
  in progress is still outlined whole every frame. If very long strokes show it, the current app's
  chunked bake (README, *A long stroke is drawn a chunk at a time*) is the known fix.

**The same ink as the current app.** Strokes are outlined by a **C# port of perfect-freehand 1.2.3**
(`KKNotes.Core/Ink/Freehand.cs`), line for line, quirks included. The brushes' numbers are those of
`src/inking/engine/brushes.ts`. Samples are thinned on arrival as `StrokeBuilder` does
(0.4 page units). Pressure is clamped to (0, 1] with 0 read as 0.5, and tilt becomes the same 0–1 lean.
A port can drift unnoticed, so the tests run **the library itself**. The real JavaScript build
(`KKNotes.Core.Tests/Reference/`, MIT) runs under Jint, an interpreter for .NET, and its outline is
compared point for point with the port's. That covers 8 strokes × 8 styles × live/finished, from a single dot to
1,200 samples of handwriting, including the zigzag that exercises the corner caps.

**Writing small at a high zoom.** The owner found writing small zoomed in "messy" **in both apps**. Two
distances that both apps treat as noise are fixed in page units, tuned for 100 %, where a page unit is
a pixel or two. At 400 % they cover four times as much of a letter on screen:

- **Sample thinning** drops a sample closer than 0.4 units to the last one kept. In the Z13 test, small
  slow writing at a high zoom kept 1 sample in 5 to 1 in 9 (the log's per-stroke line, "kept").
- **perfect-freehand skips the last 3 units of every line** as pen-lift noise (`END_NOISE_THRESHOLD`, a
  constant, not an option). It then joins the end on straight. At 400 % that is about 2.7 mm on
  screen, much of a small letter. Wherever the pen curls as it lifts (a "t"'s foot, the tail of a "g",
  the closing of an "o"), the straight join twists into a thin neck ending in a dot. Those were the
  dots after "Let." and "extra." in the owner's screenshot.

Both are now measured on the screen. A stroke remembers the zoom it was written at
(`StrokeStyle.WritingZoom`, never below 1). The thinning distance is divided by it. For the outline,
the stroke goes through perfect-freehand **scaled up by that zoom**, with points, size and tapers
multiplied, and the outline comes back divided by it. Everything else perfect-freehand measures is
relative to the size, so only the end skip changes: 3 units *on screen*. Doing it around the library
rather than inside it keeps the port exact, and lets the current app make the identical change around
the JavaScript original. The tests check the scaled path against the real library scaled the same
way. They also check that a curl at a stroke's end is now inked and was cut off before. `--snapshot
small.png --demo small` draws synthetic small writing both ways, old above and new below. *Zoom-aware*
in the toolbar turns it off for new strokes, to compare. The current app does the same
(`src/inking/engine/writingZoom.ts`) and saves it as `style.writingZoom` in `.notex`. It is stored only
above 100 % and to three decimals, and this app rounds it the same way, so a stroke outlines alike in
both.

What it does not change: a 1-unit pen is thick for letters a few units tall, so small loops still fill
in, and the ballpoint's hard-edged outline shows corners when magnified.

Some differences are deliberate, and the reasons are below.

- **The highlighter** multiplies in the current app. Here it is filled with a *min* blend of the same tint.
  On paper that looks the same (dark ink stays dark under it), except that two passes over one spot do
  not darken. Ink is kept to the page by painting the desk back around it rather than with a clip
  layer, because a layer starts transparent and the blend needs the paper beneath.
- **The pen's second button / eraser end** borrows the eraser. In the current app it defaults to the
  lasso, which the prototype does not have. Windows reports some pens' second button as the eraser flag.
  The measurement line shows which flag each button sets, as the current app's pen button test does.
- **Pencil, marker and brush** strokes get the right outline but not their grain or bleed. The toolbar does not offer
  them.

## Comparing it with the current app

The owner draws the same things in both apps on the Z13, one after the other:

1. Set the display to **60 Hz**. Open a blank page in the current app with the 1 px ballpoint, and the
   prototype likewise (*Ballpoint*, 1 px). Use about the same zoom: the prototype shows its zoom in the
   measurement line.
2. In each: draw **fast circles** and watch the gap between the nib and the end of the ink; **write a
   sentence** at normal speed; draw **slow lines**.
3. Do the same at **180 Hz**, then in **full screen** in both (F11), also watching the mouse pointer.
4. In the prototype only: try *Prediction: off* and *30 ms* against the default, and *Present on v-sync*.
   Note what feels best, and whether prediction overshoots visibly at the turns.
5. For an objective comparison, a phone's slow-motion video (240 fps) of fast circles shows the gap
   between nib and ink frame by frame.

**Then stop and decide** (HANDOFF.md): is it clearly better? Only then does step 2 (the `.notex` files)
begin.

## Files

```
windows-native/
├── KKNotes.Native.sln
├── KKNotes.Core/              no WinUI: tested with plain xUnit
│   ├── Ink/Freehand.cs        perfect-freehand, ported
│   ├── Ink/Brushes.cs         brush presets, style → outline options, tilt
│   ├── Ink/Stroke.cs          InkPoint, StrokeStyle, Stroke (the .notex stroke, so far)
│   ├── Ink/StrokeBuilder.cs   the stroke being drawn: thinning, bounds
│   ├── Ink/HitTest.cs         the stroke eraser's segment test
│   ├── Ink/InkPage.cs         a page's strokes and undo history
│   ├── Ink/BarrelButton.cs    click-or-hold state machine (port of barrelButton.ts)
│   ├── Ink/TouchGate.cs       palm rejection for touch gestures
│   └── View/PageCamera.cs     zoom and pan of the page
├── KKNotes.Core.Tests/        xUnit; Reference/ holds perfect-freehand's JS build
└── KKNotes.Native/            the WinUI 3 app
    ├── MainWindow.xaml(.cs)   toolbar, measurement line, the drawing panel
    ├── Ink/InkSurface.cs      shared state and the UI thread's side
    ├── Ink/InkSurface.Input.cs   pen, mouse, touch, barrel button, prediction (input thread)
    ├── Ink/InkSurface.Render.cs  swap chain, dry/wet drawing, snapshot (render thread)
    ├── Ink/DemoPage.cs        the --snapshot page
    ├── Interop/Win32.cs       frame latency, refresh rate, clock
    └── Log.cs                 %TEMP%\KKNotes.Native.log
```
