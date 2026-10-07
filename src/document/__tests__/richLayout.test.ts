import { describe, expect, it } from 'vitest';
import { layoutRich, paintRich, type Measure, type RichPainter } from '../richLayout';
import type { RichBase } from '../richText';
import type { RichText } from '../types';

/** Every character half as wide as the text is tall, bold or not. */
const measure: Measure = (text, style) => text.length * style.size * 0.5;
const BASE: RichBase = { fontFamily: 'sans', fontSize: 10, color: '#000000', align: 'left' };

/** Each line's pieces, `|` between them. */
function words(rich: RichText, width: number): string[][] {
  return layoutRich(rich, BASE, width, measure).blocks.map((b) => b.lines.map((l) => l.pieces.map((p) => p.text).join('|')));
}

describe('laying out rich text', () => {
  it('fills lines with whole words and wraps the rest', () => {
    // Each character is 5 wide: 60 holds "aaaa bbbb" (45) but not "aaaa bbbb cccc" (70).
    const rich: RichText = { blocks: [{ runs: [{ text: 'aaaa bbbb cccc' }] }] };
    // One style, so one piece a line; the space at the end of a line hangs past it and is not drawn.
    expect(words(rich, 60)).toEqual([['aaaa bbbb', 'cccc']]);
  });

  it('keeps a word in two styles together, and breaks a word longer than a line by characters', () => {
    const rich: RichText = { blocks: [{ runs: [{ text: 'xx ab' }, { text: 'cd', bold: true }, { text: ' ' + 'z'.repeat(15) }] }] };
    // "xx ab" and the bold "cd" are 35 of the 40; fifteen z's (75) are cut where the line ends.
    expect(words(rich, 40)).toEqual([['xx ab|cd', 'zzzzzzzz', 'zzzzzzz']]);
  });

  it('starts a new line at a line break, and gives an empty paragraph a line of its own', () => {
    const rich: RichText = { blocks: [{ runs: [{ text: 'one\ntwo' }] }, { runs: [] }] };
    const layout = layoutRich(rich, BASE, 500, measure);
    expect(layout.blocks[0]!.lines).toHaveLength(2);
    expect(layout.blocks[1]!.lines).toHaveLength(1);
    expect(layout.blocks[1]!.lines[0]!.height).toBeCloseTo(13.5);
  });

  it('makes a line as tall as its largest text, with the baseline where a browser puts it', () => {
    const rich: RichText = { blocks: [{ runs: [{ text: 'small ' }, { text: 'BIG', size: 20 }] }] };
    const line = layoutRich(rich, BASE, 500, measure).blocks[0]!.lines[0]!;
    expect(line.height).toBeCloseTo(27);
    expect(line.baseline).toBeCloseTo(20 * 1.08);
  });

  it('collapses the space between paragraphs to the larger of the two, as CSS margins do', () => {
    // A paragraph has 0.4 of its size below it; a heading 0.6 of its own (1.75 × 10) above.
    const rich: RichText = { blocks: [{ runs: [{ text: 'p' }] }, { kind: 'h1', runs: [{ text: 'H' }] }] };
    const [p, h] = layoutRich(rich, BASE, 500, measure).blocks;
    expect(h!.top - p!.bottom).toBeCloseTo(0.6 * 17.5);
  });

  it('indents lists by level and puts the marker before the text', () => {
    const rich: RichText = { blocks: [{ list: 'number', runs: [{ text: 'a' }] }, { list: 'bullet', indent: 1, runs: [{ text: 'b' }] }] };
    const [first, second] = layoutRich(rich, BASE, 500, measure).blocks;
    expect(first!.lines[0]!.pieces[0]!.x).toBeCloseTo(16);
    expect(second!.lines[0]!.pieces[0]!.x).toBeCloseTo(32);
    expect(first!.markerRight).toBeLessThan(16);
    expect(first!.marker).toEqual({ kind: 'number', text: '1.' });
  });

  it('centres, right-aligns and justifies', () => {
    // At 90 the first line holds "aa bb cc dd ee ff" (85); "gg" goes to the next.
    const line = (align: 'center' | 'right' | 'justify', width = 90) =>
      layoutRich({ blocks: [{ align, runs: [{ text: 'aa bb cc dd ee ff gg' }] }] }, BASE, width, measure).blocks[0]!.lines;
    expect(line('center')[0]!.pieces[0]!.x).toBeCloseTo(2.5);
    expect(line('right')[0]!.pieces[0]!.x).toBeCloseTo(5);
    // Justified: the first line reaches the right edge; the last is left alone.
    const justified = line('justify');
    const firstLine = justified[0]!;
    const lastPiece = firstLine.pieces[firstLine.pieces.length - 1]!;
    expect(lastPiece.x + lastPiece.width).toBeCloseTo(90);
    expect(justified[1]!.pieces[0]!.x).toBe(0);
  });

  it('draws highlights behind, rules over, and a ticked item struck through and faded', () => {
    const calls: string[] = [];
    const painter: RichPainter = {
      text: (text, _x, _b, _s, opacity) => calls.push(`text ${text} ${opacity}`),
      rect: (_x, _t, _w, _h, color) => calls.push(`rect ${color}`),
      circle: () => calls.push('circle'),
      polyline: () => calls.push('tick'),
      square: () => calls.push('box'),
    };
    const rich: RichText = {
      blocks: [
        { runs: [{ text: 'hi', highlight: '#ffff00', underline: true, color: '#ff0000' }] },
        { list: 'check', checked: true, runs: [{ text: 'done' }] },
      ],
    };
    paintRich(layoutRich(rich, BASE, 500, measure), painter, BASE);
    expect(calls).toEqual(['rect #ffff00', 'text hi 1', 'rect #ff0000', 'box', 'tick', 'text done 0.55', 'rect #000000']);
  });
});
