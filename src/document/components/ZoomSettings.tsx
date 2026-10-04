import { useShallow } from 'zustand/react/shallow';
import { usePreferencesStore } from '../../preferences/store';
import { DEFAULT_ZOOM_PREFERENCES, PINCH_SPEED_RANGE, PINCH_THRESHOLD_RANGE, ZOOM_STEP_RANGE } from '../../preferences/types';
import { Row } from '../../ui/SettingsRow';

const NOTE = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';
const SLIDER = 'h-1 w-28 accent-blue-600';
const VALUE = 'w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400';

/**
 * How zooming feels, in the settings: how far a pinch goes for the same movement of the fingers, how much of a pinch
 * it takes before the zoom moves at all, and how big a step + / − and a Ctrl + mouse wheel notch are.
 */
export function ZoomSettings() {
  const { pinchSpeed, pinchThreshold, zoomStep, set } = usePreferencesStore(
    useShallow((s) => ({ ...s.zoom, set: s.setZoomPreferences })),
  );
  const changed =
    pinchSpeed !== DEFAULT_ZOOM_PREFERENCES.pinchSpeed ||
    pinchThreshold !== DEFAULT_ZOOM_PREFERENCES.pinchThreshold ||
    zoomStep !== DEFAULT_ZOOM_PREFERENCES.zoomStep;
  return (
    <>
      <Row label="Pinch speed">
        <input
          type="range"
          className={SLIDER}
          min={PINCH_SPEED_RANGE.min}
          max={PINCH_SPEED_RANGE.max}
          step={0.05}
          value={pinchSpeed}
          aria-label="Pinch speed"
          onChange={(e) => set({ pinchSpeed: Number(e.target.value) })}
          data-zoom-pinch-speed
        />
        <span className={VALUE}>{Number(pinchSpeed.toFixed(2))}×</span>
      </Row>
      <Row label="Pinch threshold">
        <input
          type="range"
          className={SLIDER}
          min={PINCH_THRESHOLD_RANGE.min}
          max={PINCH_THRESHOLD_RANGE.max}
          step={0.01}
          value={pinchThreshold}
          aria-label="Pinch threshold"
          onChange={(e) => set({ pinchThreshold: Number(e.target.value) })}
          data-zoom-pinch-threshold
        />
        <span className={VALUE}>{pinchThreshold === 0 ? 'Off' : `${Math.round(pinchThreshold * 100)}%`}</span>
      </Row>
      <Row label="Zoom step">
        <input
          type="range"
          className={SLIDER}
          min={ZOOM_STEP_RANGE.min}
          max={ZOOM_STEP_RANGE.max}
          step={5}
          value={zoomStep}
          aria-label="Zoom step"
          onChange={(e) => set({ zoomStep: Number(e.target.value) })}
          data-zoom-step
        />
        <span className={VALUE}>{zoomStep}%</span>
      </Row>
      <p className={NOTE} data-zoom-note>
        Speed: how far the zoom goes for the same pinch (1× follows your fingers). Threshold: how much you pinch
        before it zooms at all — raise it if scrolling with two fingers zooms by accident. Both are for the touchpad
        and two fingers on the screen. Step: one click of + / −, or one notch of Ctrl + mouse wheel.
        {changed && (
          <>
            {' '}
            <button
              type="button"
              className="font-medium text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => set(DEFAULT_ZOOM_PREFERENCES)}
              data-zoom-reset
            >
              Reset zoom
            </button>
          </>
        )}
      </p>
    </>
  );
}
