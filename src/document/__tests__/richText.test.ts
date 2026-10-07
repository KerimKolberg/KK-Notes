import { describe, expect, it } from 'vitest';
import { createTextBox } from '../media';
import {
  countWords,
  listMarkers,
  mergeContinuations,
  normalizeRuns,
  numberLabel,
  plainText,
  readRich,
  richFromPlain,
  richOf,
  richPatch,
  sliceRuns,
  splitBlock,
  textStats,
} from '../richText';
import type { RichBlock, RichList } from '../types';

const PAGE = { width: 800, height: 1000 };

describe('rich text from a box', () => {
  it('reads a box written before formatting in parts as its text in its style, a paragraph per line', () => {
    const box = { ...createTextBox(PAGE, 1), text: 'Title\n\nBody', bold: true, underline: true };
    const rich = richOf(box);
    expect(rich.blocks).toHaveLength(3);
    expect(rich.blocks[0]!.runs).toEqual([{ bold: true, underline: true, text: 'Title' }]);
    expect(rich.blocks[1]!.runs).toEqual([]);
    expect(plainText(rich)).toBe('Title\n\nBody');
  });

  it('prefers the rich text, and keeps the plain words and the box style in step when it is stored', () => {
    const rich = { blocks: [{ kind: 'h1' as const, runs: [{ text: 'Hi', italic: true }] }, { list: 'bullet' as const, runs: [{ text: 'one' }] }] };
    const patch = richPatch(rich);
    expect(patch.text).toBe('Hi\none');
    expect([patch.bold, patch.italic, patch.underline, patch.strikethrough]).toEqual([false, false, false, false]);
    const box = { ...createTextBox(PAGE, 1), ...patch };
    expect(richOf(box)).toEqual(rich);
  });

  it('leaves out what a file has wrong rather than trusting it', () => {
    const rich = readRich({
      blocks: [
        { kind: 'h9', list: 'stars', indent: 99, runs: [{ text: 'ok', size: -3, font: 'comic', bold: 'yes' }, { nope: 1 }] },
        'garbage',
      ],
    });
    expect(rich).toEqual({ blocks: [{ indent: 6, runs: [{ text: 'ok' }] }] });
    expect(readRich({ blocks: [] })!.blocks).toHaveLength(1);
    expect(readRich('text')).toBeNull();
  });

  it('merges neighbouring runs in the same style and drops empty ones', () => {
    expect(normalizeRuns([{ text: 'a', bold: true }, { text: '' }, { text: 'b', bold: true }, { text: 'c' }])).toEqual([
      { text: 'ab', bold: true },
      { text: 'c' },
    ]);
  });
});

describe('lists', () => {
  const item = (list: RichList, indent = 0, extra: Partial<RichBlock> = {}): RichBlock => ({ list, indent, runs: [{ text: 'x' }], ...extra });

  it('numbers items at their level, a. and i. further in, and starts again after other text', () => {
    const markers = listMarkers([
      item('number'),
      item('number'),
      item('number', 1),
      item('number', 1),
      item('number', 2),
      item('number'),
      { runs: [{ text: 'between' }] },
      item('number'),
    ]);
    expect(markers.map((m) => (m && m.kind === 'number' ? m.text : null))).toEqual(['1.', '2.', 'a.', 'b.', 'i.', '3.', null, '1.']);
  });

  it('starts a sub-list again under each item further out', () => {
    const markers = listMarkers([item('number'), item('number', 1), item('number'), item('number', 1)]);
    expect(markers.map((m) => (m && m.kind === 'number' ? m.text : ''))).toEqual(['1.', 'a.', '2.', 'a.']);
  });

  it('gives bullets a shape per level, and checklist items their tick', () => {
    const markers = listMarkers([item('bullet'), item('bullet', 1), item('bullet', 2), item('check', 0, { checked: true }), item('check')]);
    expect(markers.map((m) => m && (m.kind === 'bullet' ? m.shape : m.kind === 'check' ? m.checked : m.text))).toEqual([
      'disc',
      'circle',
      'square',
      true,
      false,
    ]);
  });

  it('shows no marker on the rest of a paragraph carried from the page before, and does not count it', () => {
    const markers = listMarkers([item('number'), item('number', 0, { cont: true }), item('number')]);
    expect(markers.map((m) => (m && m.kind === 'number' ? m.text : null))).toEqual(['1.', null, '2.']);
  });

  it('writes numbers as Word does at each level', () => {
    expect([numberLabel(1, 0), numberLabel(28, 1), numberLabel(14, 2), numberLabel(3, 3)]).toEqual(['1.', 'ab.', 'xiv.', '3.']);
  });
});

describe('counting words', () => {
  it('counts words between spaces with a letter or a digit in them', () => {
    expect(countWords('The quick  brown fox — jumps 2 times.')).toBe(7);
    expect(countWords('  ')).toBe(0);
    expect(countWords("don't stop-motion")).toBe(2);
  });

  it('counts each character of Chinese and Japanese, which put no spaces between words', () => {
    expect(countWords('我爱你')).toBe(3);
    expect(countWords('こんにちは world')).toBe(6);
  });

  it('counts characters with and without spaces, and paragraphs with something in them', () => {
    expect(textStats(['Hello world\n\nAgain', 'One'])).toEqual({ words: 4, characters: 19, charactersNoSpaces: 18, paragraphs: 3 });
  });
});

describe('cutting and joining paragraphs', () => {
  const block: RichBlock = { kind: 'h2', list: 'number', runs: [{ text: 'Hello ', bold: true }, { text: 'world' }] };

  it('slices runs between character positions', () => {
    expect(sliceRuns(block.runs, 3, 8)).toEqual([{ text: 'lo ', bold: true }, { text: 'wo' }]);
  });

  it('cuts a paragraph into itself and a continuation, and joins them back as they were', () => {
    const [head, tail] = splitBlock(block, 8);
    expect(head).toEqual({ kind: 'h2', list: 'number', runs: [{ text: 'Hello ', bold: true }, { text: 'wo' }] });
    expect(tail).toEqual({ kind: 'h2', list: 'number', cont: true, runs: [{ text: 'rld' }] });
    expect(mergeContinuations([head, tail])).toEqual([block]);
  });

  it('takes a continuation with nothing before it for a paragraph of its own', () => {
    expect(mergeContinuations([{ cont: true, runs: [{ text: 'x' }] }])).toEqual([{ runs: [{ text: 'x' }] }]);
  });

  it('turns plain text into paragraphs, one per line', () => {
    expect(richFromPlain('a\nb').blocks.map((b) => b.runs.map((r) => r.text).join(''))).toEqual(['a', 'b']);
  });
});
