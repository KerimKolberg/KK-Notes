import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESSURE, PALM_REJECTION_GRACE_MS, PEN_PROXIMITY_TIMEOUT_MS } from '../constants';
import {
  isBarrelPress,
  isEraserEndPress,
  isPointerAccepted,
  normalizePointerType,
  normalizePressure,
  resolveEffectiveTool,
} from '../engine/pointerPolicy';

describe('normalizePressure', () => {
  it('falls back to the default when the device reports 0', () => {
    expect(normalizePressure(0)).toBe(DEFAULT_PRESSURE);
    expect(normalizePressure(Number.NaN)).toBe(DEFAULT_PRESSURE);
    expect(normalizePressure(-1)).toBe(DEFAULT_PRESSURE);
  });

  it('passes through valid pressure and clamps above 1', () => {
    expect(normalizePressure(0.25)).toBe(0.25);
    expect(normalizePressure(1)).toBe(1);
    expect(normalizePressure(1.7)).toBe(1);
  });
});

describe('normalizePointerType', () => {
  it('maps unknown types to mouse', () => {
    expect(normalizePointerType('pen')).toBe('pen');
    expect(normalizePointerType('touch')).toBe('touch');
    expect(normalizePointerType('mouse')).toBe('mouse');
    expect(normalizePointerType('')).toBe('mouse');
  });
});

describe('isPointerAccepted', () => {
  const base = { touchDraw: false, allowMouse: true, penInProximity: false, msSincePen: Infinity };

  it('always accepts the pen', () => {
    expect(isPointerAccepted({ ...base, pointerType: 'pen', penInProximity: true, msSincePen: 0 })).toBe(true);
  });

  it('rejects touch unless Touch Draw is on', () => {
    expect(isPointerAccepted({ ...base, pointerType: 'touch' })).toBe(false);
    expect(isPointerAccepted({ ...base, pointerType: 'touch', touchDraw: true })).toBe(true);
  });

  it('rejects touch while a pen is in proximity or was just seen (palm rejection)', () => {
    const touch = { ...base, pointerType: 'touch' as const, touchDraw: true };
    expect(isPointerAccepted({ ...touch, penInProximity: true, msSincePen: 0 })).toBe(false);
    expect(isPointerAccepted({ ...touch, penInProximity: true, msSincePen: PALM_REJECTION_GRACE_MS })).toBe(false);
    expect(isPointerAccepted({ ...touch, msSincePen: PALM_REJECTION_GRACE_MS - 1 })).toBe(false);
    expect(isPointerAccepted({ ...touch, msSincePen: PALM_REJECTION_GRACE_MS })).toBe(true);
  });

  it('lets a stale proximity flag expire so touch is never locked out forever', () => {
    const touch = { ...base, pointerType: 'touch' as const, touchDraw: true, penInProximity: true };
    expect(isPointerAccepted({ ...touch, msSincePen: PEN_PROXIMITY_TIMEOUT_MS - 1 })).toBe(false);
    expect(isPointerAccepted({ ...touch, msSincePen: PEN_PROXIMITY_TIMEOUT_MS })).toBe(true);
  });

  it('honours allowMouse', () => {
    expect(isPointerAccepted({ ...base, pointerType: 'mouse' })).toBe(true);
    expect(isPointerAccepted({ ...base, pointerType: 'mouse', allowMouse: false })).toBe(false);
  });
});

describe('resolveEffectiveTool', () => {
  it('uses the selected tool for a plain pen contact', () => {
    expect(resolveEffectiveTool('highlighter', 'pen', 0, 1)).toBe('highlighter');
  });

  it('switches to the stroke eraser for the pen eraser end', () => {
    expect(resolveEffectiveTool('pen', 'pen', 5, 32)).toBe('eraser-stroke');
  });

  it('switches to the stroke eraser for barrel button + contact', () => {
    expect(resolveEffectiveTool('pen', 'pen', 0, 1 | 2)).toBe('eraser-stroke');
  });

  it('ignores a barrel press while hovering (no contact)', () => {
    expect(resolveEffectiveTool('pen', 'pen', 2, 2)).toBeNull();
  });

  it('falls back to `button` when `buttons` is missing', () => {
    expect(resolveEffectiveTool('pen', 'pen', 0, 0)).toBe('pen');
    expect(resolveEffectiveTool('pen', 'pen', 5, 0)).toBe('eraser-stroke');
  });

  it('only accepts the primary mouse button', () => {
    expect(resolveEffectiveTool('pen', 'mouse', 0, 1)).toBe('pen');
    expect(resolveEffectiveTool('pen', 'mouse', 2, 2)).toBeNull();
  });

  it('touch always uses the selected tool', () => {
    expect(resolveEffectiveTool('eraser-pixel', 'touch', 0, 1)).toBe('eraser-pixel');
  });

  it('honours stylus mappings for the barrel button and eraser end', () => {
    const stylus = { barrelButton: 'select' as const, eraserEnd: 'eraser-pixel' as const };
    expect(resolveEffectiveTool('pen', 'pen', 0, 1 | 2, stylus)).toBe('select');
    expect(resolveEffectiveTool('pen', 'pen', 5, 32, stylus)).toBe('eraser-pixel');
    expect(resolveEffectiveTool('pen', 'pen', 2, 0, stylus)).toBe('select'); // drivers without `buttons`
    const pixel = { barrelButton: 'eraser-pixel' as const, eraserEnd: 'eraser-stroke' as const };
    expect(resolveEffectiveTool('highlighter', 'pen', 0, 3, pixel)).toBe('eraser-pixel');
    // Mouse and touch never see stylus mappings.
    expect(resolveEffectiveTool('pen', 'mouse', 2, 2, stylus)).toBeNull();
    expect(resolveEffectiveTool('pen', 'touch', 0, 1, stylus)).toBe('pen');
  });

  it('detects barrel and eraser-end presses', () => {
    expect(isBarrelPress('pen', 0, 3)).toBe(true);
    expect(isBarrelPress('pen', 2, 0)).toBe(true);
    expect(isBarrelPress('pen', 0, 1)).toBe(false);
    expect(isBarrelPress('mouse', 2, 2)).toBe(false);
    expect(isEraserEndPress('pen', 5, 32)).toBe(true);
    expect(isEraserEndPress('pen', 0, 1)).toBe(false);
  });
});
