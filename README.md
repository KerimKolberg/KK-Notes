# InkingCanvas

A standalone, low-latency inking surface for React + TypeScript, tuned for
2-in-1 pen/touch laptops. Full-viewport HTML5 canvas, high-DPI aware, with
palm rejection, pressure-sensitive strokes via [perfect-freehand], and an
undo/redo stack.

```bash
npm install
npm run dev        # Vite dev server
npm test           # unit tests (vitest)
npm run typecheck  # strict tsc
npm run build      # typecheck + production bundle
```

## Usage

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

The component fills its parent, so size the parent (the demo `App` uses the
whole viewport). `ref` exposes `undo()`, `redo()`, `clear()`, `getStrokes()`
and `toDataURL()`.

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

**Strokes.** `engine/strokeOutline.ts` feeds `{x, y, pressure}` samples to
perfect-freehand's `getStroke`, which streamlines the input, derives a per
point radius from pressure (or from velocity for pointers without a sensor),
offsets left/right along the normal and returns a closed polygon. The polygon
is turned into a `Path2D` of quadratic curves through vertex midpoints and
filled with `nonzero` winding. Committed paths are memoised in a `WeakMap`.

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
├── InkingCanvas.tsx        component: layers, sync, imperative handle
├── InkingToolbar.tsx       tools, colour, width, Touch Draw, undo/redo/clear
├── InkingCanvas.module.css
├── types.ts                Stroke, StrokeStyle, ToolSettings, HistoryEntry, …
├── constants.ts
├── engine/                 framework-free, unit-tested core
│   ├── strokeOutline.ts    perfect-freehand integration → Path2D
│   ├── renderer.ts         layer drawing, path cache, eraser cursor
│   ├── hitTest.ts          stroke-eraser geometry
│   ├── history.ts          undo/redo reducer
│   ├── pointerPolicy.ts    palm rejection, pressure, button mapping
│   ├── toolStyles.ts       per-tool StrokeStyle
│   ├── strokeBuilder.ts    in-progress stroke accumulator
│   └── geometry.ts
└── hooks/
    ├── usePointerInk.ts    pointer state machine + rAF live rendering
    ├── useHiDpiCanvas.ts   DPR-aware sizing
    ├── useHistory.ts
    ├── useUndoRedoShortcuts.ts
    └── useLatestRef.ts
```

[perfect-freehand]: https://github.com/steveruizok/perfect-freehand
