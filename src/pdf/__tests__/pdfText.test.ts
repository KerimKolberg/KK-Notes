import { describe, expect, it } from 'vitest';
import { joinTextItems } from '../pdfText';

describe('joining the pieces of a PDF page', () => {
  it('runs the pieces together as they come', () => {
    expect(joinTextItems([{ str: 'Hel' }, { str: 'lo' }, { str: ' ' }, { str: 'world' }])).toBe('Hello world');
  });

  it('puts a space where a line ended, so the last word of one line and the first of the next stay apart', () => {
    expect(joinTextItems([{ str: 'the end', hasEOL: true }, { str: 'of it' }])).toBe('the end of it');
  });

  it('does not double a space that is there already', () => {
    expect(joinTextItems([{ str: 'the end ', hasEOL: true }, { str: 'of it' }])).toBe('the end of it');
  });

  it('squeezes runs of white space and trims the ends', () => {
    expect(joinTextItems([{ str: '  a   b ' }, { str: '\n c  ' }])).toBe('a b c');
  });

  it('skips marked-content pieces that have no text', () => {
    expect(joinTextItems([{ str: 'a' }, {}, { hasEOL: true }, { str: 'b' }])).toBe('a b');
  });

  it('is nothing for nothing', () => {
    expect(joinTextItems([])).toBe('');
  });
});
