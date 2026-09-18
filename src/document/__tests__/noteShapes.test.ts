import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS, NOTE_GRIP_HEIGHT, NOTE_PADDING } from '../constants';
import {
  createStickyNote,
  noteBodyBox,
  noteLipHeight,
  noteShapeOf,
  noteTailPoints,
  noteTailSize,
  noteTextBox,
  noteTextLocalBox,
} from '../media';
import type { StickyNote } from '../types';

const page = A4_DIMENSIONS;
const note = (over: Partial<StickyNote> = {}): StickyNote => ({ ...createStickyNote(page, 1), ...over });

/** Is the local point inside the ellipse inscribed in the note's box? */
const insideEllipse = (n: StickyNote, x: number, y: number): boolean => {
  const dx = (x - n.width / 2) / (n.width / 2);
  const dy = (y - n.height / 2) / (n.height / 2);
  return dx * dx + dy * dy <= 1 + 1e-9;
};

describe('note shapes', () => {
  it('defaults to a rectangle, including for notes saved before shapes existed', () => {
    expect(noteShapeOf(createStickyNote(page, 1))).toBe('rectangle');
    const legacy = { ...createStickyNote(page, 1) } as StickyNote & { shape?: undefined };
    delete legacy.shape;
    expect(noteShapeOf(legacy)).toBe('rectangle');
  });

  it('takes the shape it was created with', () => {
    expect(noteShapeOf(createStickyNote(page, 1, undefined, { shape: 'bubble' }))).toBe('bubble');
    expect(createStickyNote(page, 1, undefined, { color: '#fff' }).color).toBe('#fff');
  });

  it('gives only the rectangle a drag lip', () => {
    expect(noteLipHeight(note({ shape: 'rectangle' }))).toBe(NOTE_GRIP_HEIGHT);
    expect(noteLipHeight(note({ shape: 'ellipse' }))).toBe(0);
    expect(noteLipHeight(note({ shape: 'bubble' }))).toBe(0);
  });

  it('keeps a bubble body above its tail, and fills the box otherwise', () => {
    const bubble = note({ shape: 'bubble' });
    const tail = noteTailSize(bubble);
    expect(tail.height).toBeGreaterThan(0);
    expect(noteBodyBox(bubble).height).toBeCloseTo(bubble.height - tail.height);
    expect(noteBodyBox(note({ shape: 'rectangle' })).height).toBe(bubble.height);
    expect(noteBodyBox(note({ shape: 'ellipse' })).height).toBe(bubble.height);
  });

  it('shrinks the tail with the note rather than letting it take over', () => {
    const tiny = note({ shape: 'bubble', width: 40, height: 40 });
    const tail = noteTailSize(tiny);
    expect(tail.width).toBeLessThanOrEqual(tiny.width * 0.35);
    expect(tail.height).toBeLessThanOrEqual(tiny.height * 0.25);
    // And it still hangs below the body, pointing down-left.
    const [a, b, tip] = noteTailPoints(tiny);
    expect(tip.y).toBeGreaterThan(a.y);
    expect(b.x).toBeGreaterThan(a.x);
    expect(tip.x).toBeGreaterThanOrEqual(a.x);
    expect(b.x).toBeLessThanOrEqual(tiny.width);
  });
});

describe('where the text goes', () => {
  it('sits below the lip and inside the padding on a rectangle', () => {
    const card = note({ shape: 'rectangle' });
    const box = noteTextLocalBox(card);
    expect(box.x).toBe(NOTE_PADDING);
    expect(box.y).toBe(NOTE_GRIP_HEIGHT + NOTE_PADDING);
    expect(box.width).toBeCloseTo(card.width - NOTE_PADDING * 2);
  });

  it('fits inside the oval at every corner, which is what stops text spilling out', () => {
    const oval = note({ shape: 'ellipse' });
    const box = noteTextLocalBox(oval);
    for (const [x, y] of [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ]) {
      expect(insideEllipse(oval, x!, y!)).toBe(true);
    }
    // A box that ignored the curve — the rectangle's — would not.
    const naive = noteTextLocalBox(note({ shape: 'rectangle' }));
    expect(insideEllipse(oval, naive.x, naive.y)).toBe(false);
  });

  it('stays clear of a bubble tail and its rounded corners', () => {
    const bubble = note({ shape: 'bubble' });
    const box = noteTextLocalBox(bubble);
    const body = noteBodyBox(bubble);
    expect(box.y + box.height).toBeLessThanOrEqual(body.height);
    expect(box.x).toBeGreaterThan(NOTE_PADDING);
  });

  it('never returns a collapsed box, however small the note', () => {
    for (const shape of ['rectangle', 'ellipse', 'bubble'] as const) {
      const box = noteTextLocalBox(note({ shape, width: 8, height: 8 }));
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it('places the page-space box at the note, with the same size', () => {
    const card = note({ shape: 'bubble', x: 120, y: 240 });
    const local = noteTextLocalBox(card);
    const world = noteTextBox(card);
    expect(world.x).toBeCloseTo(card.x + local.x);
    expect(world.y).toBeCloseTo(card.y + local.y);
    expect(world.width).toBeCloseTo(local.width);
    expect(world.height).toBeCloseTo(local.height);
  });
});
