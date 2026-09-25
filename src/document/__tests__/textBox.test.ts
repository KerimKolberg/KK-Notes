import { describe, expect, it } from 'vitest';
import { StandardFonts } from 'pdf-lib';
import {
  DEFAULT_TEXT_STYLE,
  TEXT_FONTS,
  TEXT_LINE_HEIGHT,
  TEXT_SIZES,
  createTextBox,
  fontById,
  pdfFontName,
  textCss,
  textStyleOf,
} from '../media';
import { A4_DIMENSIONS } from '../constants';
import type { TextBox, TextStyle } from '../types';

/**
 * The text tool's model.
 *
 * The thing worth guarding hardest is the font catalogue, because it has to be
 * true in two worlds at once: a CSS stack the screen draws with, and a PDF
 * base-14 name the export embeds. Those are checked against pdf-lib's own enum
 * rather than eyeballed — the first version of this used the enum's *key*
 * names (`HelveticaBold`) instead of its values (`Helvetica-Bold`), which
 * pdf-lib takes for a custom font and refuses outright.
 */

const box = (style: Partial<TextStyle> = {}): TextBox =>
  ({ ...createTextBox(A4_DIMENSIONS, 1), text: 'Hello', ...style }) as TextBox;

describe('the font catalogue', () => {
  it('names only fonts pdf-lib can actually embed', () => {
    const standard = new Set<string>(Object.values(StandardFonts));
    for (const family of TEXT_FONTS) {
      expect(family.pdf).toHaveLength(4);
      for (const name of family.pdf) {
        expect(standard, `${family.id}: ${name} is not a StandardFonts value`).toContain(name);
      }
    }
  });

  it('gives every family all four weight and slant combinations', () => {
    // Bold and italic are separate fonts in PDF, so a family missing one
    // silently exports as the regular cut.
    for (const family of TEXT_FONTS) {
      expect(new Set(family.pdf).size).toBe(4);
      expect(family.css).toBeTruthy();
    }
    expect(TEXT_FONTS.map((f) => f.id)).toEqual(['sans', 'serif', 'mono']);
  });

  it('resolves a style to the right cut', () => {
    const plain = { fontFamily: 'serif' as const, bold: false, italic: false };
    expect(pdfFontName(plain)).toBe('Times-Roman');
    expect(pdfFontName({ ...plain, bold: true })).toBe('Times-Bold');
    expect(pdfFontName({ ...plain, italic: true })).toBe('Times-Italic');
    expect(pdfFontName({ ...plain, bold: true, italic: true })).toBe('Times-BoldItalic');
    expect(pdfFontName({ fontFamily: 'mono', bold: true, italic: true })).toBe('Courier-BoldOblique');
  });

  it('falls back to the first family rather than throwing on an unknown one', () => {
    // A file from a future version, or one edited by hand.
    expect(fontById('cursive' as never).id).toBe('sans');
  });
});

describe('textCss', () => {
  it('turns the style into what the textarea is given', () => {
    const css = textCss({ ...DEFAULT_TEXT_STYLE, bold: true, italic: true, fontSize: 24, color: '#dc2626', align: 'center' });
    expect(css.fontWeight).toBe(700);
    expect(css.fontStyle).toBe('italic');
    expect(css.fontSize).toBe(24);
    expect(css.color).toBe('#dc2626');
    expect(css.textAlign).toBe('center');
    expect(css.lineHeight).toBe(TEXT_LINE_HEIGHT);
  });

  it('combines the two decorations, and says `none` rather than nothing', () => {
    // An empty string leaves the element's inherited decoration in place,
    // which is how a strikethrough survives being switched off.
    expect(textCss(DEFAULT_TEXT_STYLE).textDecorationLine).toBe('none');
    expect(textCss({ ...DEFAULT_TEXT_STYLE, underline: true }).textDecorationLine).toBe('underline');
    expect(textCss({ ...DEFAULT_TEXT_STYLE, strikethrough: true }).textDecorationLine).toBe('line-through');
    expect(textCss({ ...DEFAULT_TEXT_STYLE, underline: true, strikethrough: true }).textDecorationLine).toBe(
      'underline line-through',
    );
  });
});

describe('textStyleOf', () => {
  it('fills in everything a file written before this tool existed lacks', () => {
    const old = { kind: 'text', id: 't', x: 0, y: 0, width: 10, height: 10, rotation: 0, zIndex: 1, text: 'hi' } as unknown as TextBox;
    expect(textStyleOf(old)).toEqual(DEFAULT_TEXT_STYLE);
  });

  it('rejects a size that would make the box unreadable or crash a measure', () => {
    for (const bad of [0, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(textStyleOf(box({ fontSize: bad }) as TextBox).fontSize).toBe(DEFAULT_TEXT_STYLE.fontSize);
    }
    expect(textStyleOf(box({ fontSize: 48 }) as TextBox).fontSize).toBe(48);
  });

  it('treats a missing flag as off rather than as truthy', () => {
    const style = textStyleOf(box({ bold: undefined as unknown as boolean }) as TextBox);
    expect(style.bold).toBe(false);
  });
});

describe('createTextBox', () => {
  it('centres a new box on the page and starts it empty', () => {
    const made = createTextBox(A4_DIMENSIONS, 3);
    expect(made.kind).toBe('text');
    expect(made.text).toBe('');
    expect(made.zIndex).toBe(3);
    expect(made.x + made.width / 2).toBeCloseTo(A4_DIMENSIONS.width / 2);
    expect(made.y + made.height / 2).toBeCloseTo(A4_DIMENSIONS.height / 2);
    expect(textStyleOf(made)).toEqual(DEFAULT_TEXT_STYLE);
  });

  it('takes an initial style, and places where it is told', () => {
    const made = createTextBox(A4_DIMENSIONS, 1, { x: 100, y: 120 }, { fontSize: 32, bold: true, color: '#2563eb' });
    expect(made.fontSize).toBe(32);
    expect(made.bold).toBe(true);
    expect(made.color).toBe('#2563eb');
    expect(made.x + made.width / 2).toBeCloseTo(100);
  });

  it('gives every box its own id', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createTextBox(A4_DIMENSIONS, 1).id));
    expect(ids.size).toBe(20);
  });

  it('offers sizes in ascending order, all usable', () => {
    expect(TEXT_SIZES).toEqual([...TEXT_SIZES].sort((a, b) => a - b));
    expect(TEXT_SIZES.every((size) => size > 0)).toBe(true);
    expect(TEXT_SIZES).toContain(DEFAULT_TEXT_STYLE.fontSize);
  });
});
