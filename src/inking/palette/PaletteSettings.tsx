import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../../desktop/desktopStore';
import { actionRestyleFullscreen } from '../../desktop/fileActions';
import { Row, Switch } from '../../ui/SettingsRow';
import { HandwritingSettings } from '../../handwriting/HandwritingSettings';
import { ZoomSettings } from '../../document/components/ZoomSettings';
import { BackgroundSettings } from '../../desktop/BackgroundSettings';
import { DEFAULT_STYLUS_SETTINGS } from '../constants';
import { DEFAULT_PALETTE_ORDER, type PaletteDock } from '../../preferences/types';
import { DEFAULT_PREFERENCES, usePreferencesStore } from '../../preferences/store';
import { BARREL_CLICK_MS } from '../engine/barrelButton';
import type { EraserEndAction, ToolType } from '../types';
import { BARREL_TOOLS, SELECT, type PanelProps } from './parts';

/** The palette's own settings panel: where it docks, the pen buttons, colours, and the app-wide switches. */

export interface PaletteSettingsProps extends PanelProps {
  onClear: () => void;
  /** True while the palette's icons can be dragged into a new order. */
  arranging?: boolean;
  onArrangingChange?: (value: boolean) => void;
}

const DOCK_CHOICES: readonly { readonly dock: PaletteDock; readonly label: string }[] = [
  { dock: 'bottom', label: 'Bottom' },
  { dock: 'top', label: 'Top' },
  { dock: 'left', label: 'Left' },
  { dock: 'right', label: 'Right' },
  { dock: 'free', label: 'Free' },
];

/** The names Windows gives the bits of `PointerEvent.buttons`, for a pen. */
function describePenButtons(buttons: number): string {
  if (buttons === 0) return 'no button';
  const names: string[] = [];
  if (buttons & 1) names.push('pen tip (1)');
  if (buttons & 2) names.push('barrel button (2)');
  if (buttons & 32) names.push('second button / eraser (32)');
  if (buttons & ~(1 | 2 | 32)) names.push(`other (${buttons & ~(1 | 2 | 32)})`);
  return names.join(' + ');
}

/**
 * Which button the pen is reporting, live.
 *
 * Two-button pens disagree about which physical button is which — Windows sends
 * one as the barrel and the other as the eraser — and a mapping cannot be set up
 * by guessing. This shows what the pen actually says when a button is pressed, so
 * the two dropdowns above can be matched to the two buttons under the thumb.
 *
 * Listens only while the settings are open, and only re-renders when the reported
 * buttons change, not on every hover move.
 */
function PenButtonTest(): React.JSX.Element {
  const [buttons, setButtons] = useState<number | null>(null);
  useEffect(() => {
    const onPen = (e: PointerEvent): void => {
      if (e.pointerType !== 'pen') return;
      setButtons((current) => (current === e.buttons ? current : e.buttons));
    };
    // Capture, so it sees the event even if the page underneath handles it.
    window.addEventListener('pointermove', onPen, true);
    window.addEventListener('pointerdown', onPen, true);
    window.addEventListener('pointerup', onPen, true);
    return () => {
      window.removeEventListener('pointermove', onPen, true);
      window.removeEventListener('pointerdown', onPen, true);
      window.removeEventListener('pointerup', onPen, true);
    };
  }, []);
  return (
    <div className="rounded-lg bg-zinc-100 px-2 py-1.5 text-xs dark:bg-zinc-800" data-pen-button-test>
      <div className="font-medium text-zinc-700 dark:text-zinc-200">Pen button test</div>
      <div className="text-zinc-500 dark:text-zinc-400" data-pen-buttons>
        {buttons === null
          ? 'Hold the pen just above the screen and press a button.'
          : `The pen reports: ${describePenButtons(buttons)}`}
      </div>
    </div>
  );
}

/** Input settings that are not a tool: touch drawing, stylus buttons, layout, clear. */
export function PaletteSettings({
  settings,
  onSettingsChange,
  onClear,
  arranging = false,
  onArrangingChange,
}: PaletteSettingsProps) {
  const {
    paletteOrder,
    swatches,
    widthPresets,
    pageDefaults,
    resetPreferences,
    paletteDock,
    setPaletteDock,
    palettePinned,
    paletteSlide,
    setPaletteSlide,
    fullscreenStyle,
    setFullscreenStyle,
    pointerStyle,
    setPointerStyle,
    lowLatencyInk,
    setLowLatencyInk,
    handwritingSearch,
    handwritingRecognizer,
    zoom,
  } = usePreferencesStore(
    useShallow((s) => ({
      zoom: s.zoom,
      paletteOrder: s.paletteOrder,
      swatches: s.swatches,
      widthPresets: s.widthPresets,
      pageDefaults: s.pageDefaults,
      resetPreferences: s.resetPreferences,
      paletteDock: s.paletteDock,
      setPaletteDock: s.setPaletteDock,
      palettePinned: s.palettePinned,
      paletteSlide: s.paletteSlide,
      setPaletteSlide: s.setPaletteSlide,
      fullscreenStyle: s.fullscreenStyle,
      setFullscreenStyle: s.setFullscreenStyle,
      pointerStyle: s.pointerStyle,
      setPointerStyle: s.setPointerStyle,
      lowLatencyInk: s.lowLatencyInk,
      setLowLatencyInk: s.setLowLatencyInk,
      handwritingSearch: s.handwritingSearch,
      handwritingRecognizer: s.handwritingRecognizer,
    })),
  );
  // Subscribed rather than read once, so the button enables itself the moment
  // something is customised rather than on the next unrelated re-render.
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  const customised =
    pageDefaults !== null ||
    paletteOrder.join() !== DEFAULT_PALETTE_ORDER.join() ||
    swatches.join() !== DEFAULT_PREFERENCES.swatches.join() ||
    widthPresets.join() !== DEFAULT_PREFERENCES.widthPresets.join() ||
    paletteDock !== DEFAULT_PREFERENCES.paletteDock ||
    palettePinned !== DEFAULT_PREFERENCES.palettePinned ||
    paletteSlide !== DEFAULT_PREFERENCES.paletteSlide ||
    fullscreenStyle !== DEFAULT_PREFERENCES.fullscreenStyle ||
    pointerStyle !== DEFAULT_PREFERENCES.pointerStyle ||
    lowLatencyInk !== DEFAULT_PREFERENCES.lowLatencyInk ||
    handwritingSearch !== DEFAULT_PREFERENCES.handwritingSearch ||
    handwritingRecognizer !== DEFAULT_PREFERENCES.handwritingRecognizer ||
    JSON.stringify(zoom) !== JSON.stringify(DEFAULT_PREFERENCES.zoom) ||
    JSON.stringify(settings.stylus) !== JSON.stringify(DEFAULT_STYLUS_SETTINGS);
  return (
    // Scrolls instead of growing: this panel has more in it than a tablet in
    // landscape has height, and a panel taller than the screen cuts off its own
    // first rows with no way to reach them. The cap leaves room for the top bar
    // above and the toolbar it opened from.
    <div
      className="flex max-h-[calc(100dvh-12rem)] w-[min(18rem,calc(100vw-2.5rem))] flex-col gap-1 overflow-y-auto overscroll-contain pr-1"
      data-palette-settings
    >
      <Row label="Finger input">
        <Switch checked={settings.touchDraw} onChange={(v) => onSettingsChange({ touchDraw: v })}>
          Touch Draw
        </Switch>
      </Row>
      {/* One button, two gestures: a click swaps tools and leaves them
          swapped, a hold borrows one for as long as it is held. They are
          configured separately because they answer different needs. */}
      <Row label="Barrel click">
        <select
          className={SELECT}
          aria-label="Barrel click, first tool"
          data-barrel-click-a
          value={settings.stylus.clickToggle[0]}
          onChange={(e) =>
            onSettingsChange({
              stylus: { ...settings.stylus, clickToggle: [e.target.value as ToolType, settings.stylus.clickToggle[1]] },
            })
          }
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400 dark:text-zinc-500" aria-hidden="true">
          ⇄
        </span>
        <select
          className={SELECT}
          aria-label="Barrel click, second tool"
          data-barrel-click-b
          value={settings.stylus.clickToggle[1]}
          onChange={(e) =>
            onSettingsChange({
              stylus: { ...settings.stylus, clickToggle: [settings.stylus.clickToggle[0], e.target.value as ToolType] },
            })
          }
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Barrel hold">
        <select
          className={SELECT}
          aria-label="Barrel hold"
          data-barrel-hold
          value={settings.stylus.holdTool}
          onChange={(e) => onSettingsChange({ stylus: { ...settings.stylus, holdTool: e.target.value as ToolType } })}
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-barrel-note>
        A quick press swaps between the first pair and stays there. Holding the
        button past {BARREL_CLICK_MS} ms borrows the second tool until you let
        go.
      </p>
      <Row label="Second button">
        <select
          className={SELECT}
          aria-label="Second button, held"
          data-second-button
          value={settings.stylus.eraserEnd}
          onChange={(e) => onSettingsChange({ stylus: { ...settings.stylus, eraserEnd: e.target.value as EraserEndAction } })}
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-second-button-note>
        The pen&rsquo;s other button (or eraser end), held while you draw. If
        the two buttons come out the wrong way round, swap them here.
      </p>
      <PenButtonTest />
      <Row label="Toolbar">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Toolbar position">
          {DOCK_CHOICES.map((choice) => (
            <button
              key={choice.dock}
              type="button"
              aria-pressed={paletteDock === choice.dock}
              data-palette-dock-choice={choice.dock}
              className={`h-7 rounded-md px-2 text-xs font-medium ${
                paletteDock === choice.dock
                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                  : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
              }`}
              onClick={() => setPaletteDock(choice.dock)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-dock-note>
        Or drag it by its handle and push it against an edge. The pin beside the
        handle keeps it on screen; unpinned, it hides when idle and comes back
        from the tab on its edge.
      </p>
      <Row label="Toolbar layout">
        <Switch checked={paletteSlide} onChange={setPaletteSlide}>
          <span data-palette-slide>One line that slides</span>
        </Switch>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-palette-slide-note>
        {paletteSlide
          ? 'One row (one column on a side) that you slide along with a finger, the pen or the mouse wheel, like Samsung Notes. Off, it wraps onto more lines to show everything at once.'
          : 'It wraps onto more lines to show everything at once. On, it is one row (one column on a side) that you slide along, like Samsung Notes.'}
      </p>
      {isDesktop && (
        <>
          <Row label="Fullscreen (F11)">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Fullscreen style">
              {(
                [
                  { style: 'window', label: 'Borderless' },
                  { style: 'screen', label: 'Full screen' },
                ] as const
              ).map((choice) => (
                <button
                  key={choice.style}
                  type="button"
                  aria-pressed={fullscreenStyle === choice.style}
                  data-fullscreen-style={choice.style}
                  className={`h-7 rounded-md px-2 text-xs font-medium ${
                    fullscreenStyle === choice.style
                      ? 'bg-blue-600 text-white dark:bg-blue-500'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                  onClick={() => {
                    if (choice.style === fullscreenStyle) return;
                    setFullscreenStyle(choice.style);
                    // Already fullscreen: into the one chosen now, rather than at the next F11.
                    void actionRestyleFullscreen();
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </Row>
          <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-fullscreen-note>
            {fullscreenStyle === 'window'
              ? 'Borderless takes the title bar off and fills the screen above the taskbar, like a maximised window. Full screen covers the taskbar too, but on some PCs the mouse pointer lags in it.'
              : 'Full screen covers everything, the taskbar too. If the mouse pointer lags or blinks in it, Borderless fills the screen above the taskbar instead.'}
          </p>
        </>
      )}
      <Row label="Pointer">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Pointer over the page">
          {(
            [
              { style: 'cross', label: 'Small cross' },
              { style: 'crosshair', label: 'System crosshair' },
              { style: 'arrow', label: 'Arrow' },
            ] as const
          ).map((choice) => (
            <button
              key={choice.style}
              type="button"
              aria-pressed={pointerStyle === choice.style}
              data-pointer-style={choice.style}
              className={`h-7 rounded-md px-2 text-xs font-medium ${
                pointerStyle === choice.style
                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                  : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
              }`}
              onClick={() => setPointerStyle(choice.style)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-pointer-note>
        What the mouse pointer looks like over a page. If it trails the mouse in fullscreen,
        try the system crosshair or the arrow: they are drawn by Windows itself.
      </p>
      <Row label="Low-latency ink">
        <Switch checked={lowLatencyInk} onChange={setLowLatencyInk}>
          <span data-low-latency-ink>Experimental</span>
        </Switch>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-low-latency-note>
        Can save up to a frame of pen lag, but on some Windows GPUs (a ROG Flow
        Z13 was one) it turns every page dark and makes the cursor blink in
        fullscreen. Off by default; if pages go dark, switch it back off.
      </p>
      <ZoomSettings />
      <BackgroundSettings />
      <HandwritingSettings />
      <Row label="Diagnostics">
        <Switch checked={settings.debugMode} onChange={(v) => onSettingsChange({ debugMode: v })}>
          <span data-debug-mode>Debug mode</span>
        </Switch>
      </Row>
      {settings.debugMode && (
        <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-debug-mode-note>
          Shows frame rate, ink latency and React commit times in the corner.
          Nothing is measured while this is off; switching it back on clears
          the counters.
        </p>
      )}
      {onArrangingChange && (
        <>
          <Row label="Palette layout">
            <Switch checked={arranging} onChange={onArrangingChange}>
              <span data-palette-arrange>Arrange icons</span>
            </Switch>
          </Row>
          {arranging && (
            <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-palette-arrange-note>
              Drag the tool icons into the order you want. They stay where you
              put them next time. Pressing one picks it up rather than
              selecting it, so switch this back off when you are done.
            </p>
          )}
        </>
      )}

      <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-700">
        <button
          type="button"
          aria-label="Clear page"
          className="inline-flex h-8 w-full items-center justify-center rounded-lg px-2 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/50"
          onClick={onClear}
          data-clear-page
        >
          Clear page
        </button>
        <button
          type="button"
          aria-label="Reset customisations to defaults"
          disabled={!customised}
          className="inline-flex h-8 w-full items-center justify-center rounded-lg px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
          onClick={() => {
            if (window.confirm('Reset the toolbar, pen buttons, quick colours and page defaults?')) {
              resetPreferences();
              // The live tool settings hold their own copy of the pen mapping.
              onSettingsChange({ stylus: DEFAULT_STYLUS_SETTINGS });
              onArrangingChange?.(false);
            }
          }}
          data-reset-preferences
        >
          Reset to defaults
        </button>
        <p className="px-1 pt-0.5 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
          {customised ? 'Clears the toolbar position, pen buttons, colours, tool order and page defaults.' : 'Nothing has been customised yet.'}
        </p>
      </div>
    </div>
  );
}
