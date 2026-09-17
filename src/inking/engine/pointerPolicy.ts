/**
 * Pure decision logic for which pointers may draw. Kept free of DOM types so it
 * can be unit-tested and reasoned about in isolation.
 */
import { DEFAULT_PRESSURE, DEFAULT_STYLUS_SETTINGS, PALM_REJECTION_GRACE_MS, PEN_PROXIMITY_TIMEOUT_MS } from '../constants';
import type { InkPointerType, StylusSettings, ToolType } from '../types';

/** `PointerEvent.buttons` bit flags (https://w3c.github.io/pointerevents/#the-buttons-property). */
export const POINTER_BUTTONS = {
  /** Pen tip / left mouse / touch contact. */
  PRIMARY: 1,
  /** Pen barrel button / right mouse. */
  SECONDARY: 2,
  /** Pen eraser end. */
  ERASER: 32,
} as const;

export function normalizePointerType(raw: string): InkPointerType {
  return raw === 'pen' || raw === 'touch' ? raw : 'mouse';
}

/**
 * Clamp pressure into (0, 1]. Devices without a pressure sensor (and most
 * touch digitisers) report `0`, which we replace with `DEFAULT_PRESSURE` so
 * pressure-thinned tools still produce visible ink.
 */
export function normalizePressure(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PRESSURE;
  return raw > 1 ? 1 : raw;
}

export interface PointerAcceptanceContext {
  readonly pointerType: InkPointerType;
  /** The "Touch Draw" toggle. */
  readonly touchDraw: boolean;
  readonly allowMouse: boolean;
  /** A pen has entered hover range and not yet left it (see `PEN_PROXIMITY_TIMEOUT_MS`). */
  readonly penInProximity: boolean;
  /** Milliseconds since the last pen event (`Infinity` if never). */
  readonly msSincePen: number;
}

/**
 * Decide whether a pointer may start a stroke.
 *
 * - Pen always draws.
 * - Touch draws only when the toggle is on **and** no pen has been seen
 *   recently (palm rejection). A pen still flagged as hovering blocks touch
 *   for longer, until the flag goes stale.
 * - Mouse draws when `allowMouse` is set (desktop convenience).
 */
export function isPointerAccepted(ctx: PointerAcceptanceContext): boolean {
  switch (ctx.pointerType) {
    case 'pen':
      return true;
    case 'touch': {
      if (!ctx.touchDraw) return false;
      if (ctx.msSincePen < PALM_REJECTION_GRACE_MS) return false;
      if (ctx.penInProximity && ctx.msSincePen < PEN_PROXIMITY_TIMEOUT_MS) return false;
      return true;
    }
    case 'mouse':
      return ctx.allowMouse;
  }
}

/** True when a pen's barrel (side) button is part of this press. */
export function isBarrelPress(pointerType: InkPointerType, button: number, buttons: number): boolean {
  if (pointerType !== 'pen') return false;
  return buttons === 0 ? button === 2 : (buttons & POINTER_BUTTONS.SECONDARY) !== 0;
}

/** True when the pen's eraser end is touching. */
export function isEraserEndPress(pointerType: InkPointerType, button: number, buttons: number): boolean {
  if (pointerType !== 'pen') return false;
  return buttons === 0 ? button === 5 : (buttons & POINTER_BUTTONS.ERASER) !== 0;
}

/**
 * Resolve the tool for a new stroke from the selected tool and the pressed
 * buttons. Returns `null` when the press should not start anything.
 *
 * - Pen eraser end → `stylus.eraserEnd` (stroke or pixel eraser), no toolbar switch needed.
 * - Pen barrel button while touching → `stylus.barrelButton` (an eraser, or
 *   temporary select mode).
 * - Pen barrel pressed while merely hovering → ignored.
 * - Mouse: only the primary button draws.
 */
export function resolveEffectiveTool(
  selected: ToolType,
  pointerType: InkPointerType,
  button: number,
  buttons: number,
  stylus: StylusSettings = DEFAULT_STYLUS_SETTINGS,
): ToolType | null {
  if (pointerType === 'pen') {
    if (buttons === 0) {
      // Some drivers omit `buttons`; fall back to `button`.
      if (button === 0) return selected;
      if (button === 5) return stylus.eraserEnd;
      if (button === 2) return stylus.barrelButton;
      return null;
    }
    if (buttons & POINTER_BUTTONS.ERASER) return stylus.eraserEnd;
    if (!(buttons & POINTER_BUTTONS.PRIMARY)) return null;
    if (buttons & POINTER_BUTTONS.SECONDARY) return stylus.barrelButton;
    return selected;
  }
  if (pointerType === 'mouse') {
    return button === 0 ? selected : null;
  }
  return selected;
}
