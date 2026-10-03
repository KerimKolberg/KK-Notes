import { describe, expect, it } from 'vitest';
import { makeGeometric, makeStroke } from '../../inking/__tests__/testUtils';
import type { InkWord } from '../../document/types';
import type { Stroke } from '../../inking/types';
import {
  handwritingProgress,
  inkKey,
  inkLines,
  inkPageText,
  inkTextIsCurrent,
  inReadingOrder,
  isHandwriting,
  normalizeInkText,
  recognizerInput,
  recognizerLabel,
  toInkWord,
  wordAt,
} from '../inkText';

const pen = (points: [number, number][], id?: string): Stroke => makeStroke(points, id ? { id } : {});
const word = (text: string, x: number, y: number, width = 40, height = 20): InkWord => ({ text, x, y, width, height });

describe('what counts as handwriting', () => {
  it('is what the pen wrote, not the highlighter or shapes', () => {
    expect(isHandwriting(pen([[0, 0], [10, 10]]))).toBe(true);
    expect(isHandwriting(makeStroke([[0, 0], [10, 0]], { tool: 'highlighter' }))).toBe(false);
    expect(isHandwriting(makeGeometric({ type: 'line', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }))).toBe(false);
  });
});

describe('inkKey', () => {
  it('is empty for a page with no handwriting', () => {
    expect(inkKey([])).toBe('');
    expect(inkKey([makeStroke([[0, 0], [10, 0]], { tool: 'highlighter' })])).toBe('');
  });

  it('is the same for the same writing and changes when it does', () => {
    const a = pen([[0, 0], [10, 10]], 'a');
    const b = pen([[20, 0], [30, 10]], 'b');
    const key = inkKey([a, b]);
    expect(key).toMatch(/^2-/);
    expect(inkKey([a, b])).toBe(key);
    expect(inkKey([a])).not.toBe(key);
    const moved = { ...b, bbox: { ...b.bbox, minX: b.bbox.minX + 50, maxX: b.bbox.maxX + 50 } };
    expect(inkKey([a, moved])).not.toBe(key);
  });

  it('is not changed by strokes that are not handwriting', () => {
    const a = pen([[0, 0], [10, 10]], 'a');
    expect(inkKey([a, makeStroke([[0, 0], [10, 0]], { tool: 'highlighter' })])).toBe(inkKey([a]));
  });
});

describe('inkTextIsCurrent', () => {
  const a = pen([[0, 0], [10, 10]], 'a');
  it('is current when the words were read from this writing, by this recogniser', () => {
    const inkText = { key: inkKey([a]), by: 'default', words: [] };
    expect(inkTextIsCurrent({ strokes: [a], inkText }, 'default')).toBe(true);
    expect(inkTextIsCurrent({ strokes: [a], inkText }, 'German')).toBe(false);
    expect(inkTextIsCurrent({ strokes: [a, pen([[5, 5], [9, 9]])], inkText }, 'default')).toBe(false);
    expect(inkTextIsCurrent({ strokes: [a] }, 'default')).toBe(false);
  });
  it('a page with no writing is current only with no words', () => {
    expect(inkTextIsCurrent({ strokes: [] }, 'default')).toBe(true);
    expect(inkTextIsCurrent({ strokes: [], inkText: { key: 'x', by: 'default', words: [] } }, 'default')).toBe(false);
  });
});

describe('recognizerInput', () => {
  it('sends each pen stroke as x, y, pressure, leaving out points closer than a unit but never the last', () => {
    const stroke = pen([[0, 0], [0.2, 0], [0.4, 0], [5, 0], [5.3, 0]]);
    const [only] = recognizerInput([stroke]);
    expect(only!.points).toEqual([0, 0, 0.5, 5, 0, 0.5, 5.3, 0, 0.5]);
  });

  it('gives a dot a second point, and leaves out what is not handwriting', () => {
    const input = recognizerInput([pen([[3, 4]]), makeStroke([[0, 0], [10, 0]], { tool: 'highlighter' })]);
    expect(input).toHaveLength(1);
    expect(input[0]!.points).toEqual([3, 4, 0.5, 3.5, 4, 0.5]);
  });
});

describe('words', () => {
  it('takes a word only when it is one', () => {
    expect(toInkWord({ text: '  Fourier \n', x: 1, y: 2, width: 3, height: 4 })).toEqual({ text: 'Fourier', x: 1, y: 2, width: 3, height: 4 });
    expect(toInkWord({ text: ' ', x: 1, y: 2, width: 3, height: 4 })).toBeNull();
    expect(toInkWord({ text: 'x', x: Number.NaN, y: 2, width: 3, height: 4 })).toBeNull();
    expect(toInkWord('word')).toBeNull();
  });

  it('checks what a file says and drops the rest', () => {
    expect(normalizeInkText({ key: 'k', by: 'default', words: [{ text: 'a', x: 0, y: 0, width: 1, height: 1 }, { nope: 1 }] })).toEqual({
      key: 'k',
      by: 'default',
      words: [{ text: 'a', x: 0, y: 0, width: 1, height: 1 }],
    });
    expect(normalizeInkText({ key: 'k', words: [] })).toBeUndefined();
    expect(normalizeInkText('words')).toBeUndefined();
  });

  it('puts words in lines, top to bottom and left to right, whatever order they came in', () => {
    const words = [word('series', 120, 10), word('second', 10, 60), word('Fourier', 10, 14), word('line', 110, 58)];
    expect(inkLines(words).map((l) => l.map((w) => w.text))).toEqual([['Fourier', 'series'], ['second', 'line']]);
    expect(inReadingOrder(words).map((w) => w.text)).toEqual(['Fourier', 'series', 'second', 'line']);
  });

  it('makes one text of a page, and knows which word a place in it is', () => {
    const { text, spans } = inkPageText([word('series', 120, 10), word('Fourier', 10, 10), word('next', 10, 60)]);
    expect(text).toBe('Fourier series\nnext');
    expect(wordAt(spans, text.indexOf('series'))?.text).toBe('series');
    expect(wordAt(spans, text.indexOf('next') + 2)?.text).toBe('next');
    expect(wordAt(spans, 7)).toBeNull();
  });
});

describe('progress and names', () => {
  it('counts the pages with handwriting and how many are read as they are', () => {
    const a = pen([[0, 0], [10, 10]], 'a');
    const pages = [
      { strokes: [a], inkText: { key: inkKey([a]), by: 'default', words: [] } },
      { strokes: [pen([[0, 0], [9, 9]], 'b')] },
      { strokes: [] },
    ];
    expect(handwritingProgress(pages, 'default')).toEqual({ read: 1, total: 2 });
  });

  it('shortens what every recogniser is called', () => {
    expect(recognizerLabel('Microsoft English (US) Handwriting Recognizer')).toBe('English (US)');
    expect(recognizerLabel('Microsoft-Handschrifterkennung - Deutsch')).toBe('Microsoft-Handschrifterkennung - Deutsch');
  });
});
