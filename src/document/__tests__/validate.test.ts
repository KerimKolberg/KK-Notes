import { describe, expect, it } from 'vitest';
import { decodeNotex, encodeNotex } from '../../desktop/notex';
import { makeStroke } from '../../inking/__tests__/testUtils';
import { A4_DIMENSIONS } from '../constants';
import { createDocument } from '../operations';
import { fromSerializable, toSerializable } from '../serialization';
import type { SerializedDocument } from '../types';
import { MAX_PAGE_SIDE, sanitizeMedia, sanitizePage, sanitizeStroke } from '../validate';

const id = () => 'new-id';
/** A file that claims to be a note, saying whatever it likes. */
const open = (document: unknown) => fromSerializable(document as SerializedDocument);
const good = makeStroke([[10, 10], [40, 30]]);

describe('a note from a file is checked before it is a note', () => {
  it('passes a sound note through as it is, strokes uncopied', () => {
    const doc = { ...createDocument(1, 'Physics'), pages: [{ ...createDocument(1).pages[0]!, strokes: [good] }] };
    const wire = toSerializable(doc);
    const back = fromSerializable(wire);
    expect(back.pages[0]!.strokes).toBe(wire.pages[0]!.strokes);
    expect(decodeNotex(encodeNotex(doc)).title).toBe('Physics');
  });

  it('drops the stroke that cannot be drawn and keeps the rest of the page', () => {
    const page = sanitizePage(
      {
        id: 'p',
        strokes: [good, null, 'ink', { ...good, points: [{ x: 1, y: Number.NaN }] }, { ...good, points: 'many' }, { ...good, style: {} }, { ...good, id: 7 }, { kind: 'geometric', id: 'g', tool: 'line', style: good.style, shape: { type: 'spiral' } }],
      },
      id,
    );
    expect(page.strokes).toEqual([good]);
  });

  it('works a missing bounding box out again rather than losing the stroke', () => {
    const { bbox: _bbox, ...bare } = good;
    const stroke = sanitizeStroke(bare);
    expect(stroke?.bbox.minX).toBeLessThanOrEqual(10);
    expect(stroke?.bbox.maxX).toBeGreaterThanOrEqual(40);
  });

  it('holds a page to a size a canvas can be made for', () => {
    expect(sanitizePage({ dimensions: { width: 4e9, height: 800 } }, id).dimensions).toEqual({ width: MAX_PAGE_SIDE, height: 800 });
    for (const dimensions of [null, 'A4', { width: -5, height: 10 }, { width: Number.POSITIVE_INFINITY, height: 10 }, { width: '800', height: 600 }]) {
      expect(sanitizePage({ dimensions }, id).dimensions).toEqual(A4_DIMENSIONS);
    }
  });

  it('makes a page of whatever is there: a name, a template and a colour it can show', () => {
    const page = sanitizePage({ id: 42, template: 'hexagons', backgroundColor: { r: 1 }, templateConfig: { spacing: -3, strokeColor: 5, marginOffset: 96 }, formValues: { a: 'x', b: true, c: { nested: 1 } }, formFields: [{ id: 'f' }, 'field'] }, id);
    expect(page).toMatchObject({ id: 'new-id', template: 'blank', backgroundColor: '#ffffff', templateConfig: { marginOffset: 96 }, formValues: { a: 'x', b: true }, formFields: [], strokes: [], media: [] });
    expect(sanitizePage('not a page', id).strokes).toEqual([]);
    // A PDF page with no PDF page to show is a blank one.
    expect(sanitizePage({ template: 'pdf', pdf: { sourceId: 's' } }, id).template).toBe('blank');
  });

  it('takes a picture only from the note itself, never from an address the file names', () => {
    const box = { id: 'm', x: 0, y: 0, width: 100, height: 80, rotation: 0, zIndex: 1 };
    expect(sanitizeMedia({ ...box, kind: 'image', src: 'data:image/png;base64,AAAA' })).not.toBeNull();
    expect(sanitizeMedia({ ...box, kind: 'image', src: 'https://example.com/pixel.png' })).toBeNull();
    expect(sanitizeMedia({ ...box, kind: 'image', src: 'data:text/html,<script>1</script>' })).toBeNull();
    expect(sanitizeMedia({ ...box, kind: 'video' })).toBeNull();
    expect(sanitizeMedia({ ...box, kind: 'note', width: Number.NaN })).toBeNull();
    expect(sanitizeMedia({ ...box, kind: 'note', text: 9 })).toMatchObject({ text: '', color: '#fef08a' });
    expect(sanitizeMedia({ ...box, kind: 'table', rows: 2, columns: 2, cells: ['a', 3] })).toMatchObject({ cells: ['a', '', '', ''] });
    expect(sanitizeMedia({ ...box, kind: 'table', rows: 1e6, columns: 1e6 })).toBeNull();
    expect(sanitizeMedia({ ...box, kind: 'table', rows: 1, columns: 2, cells: ['a', 'b'], columnFractions: [0.3, 0.7], rowFractions: 'tall' })).toEqual({ ...box, kind: 'table', rows: 1, columns: 2, cells: ['a', 'b'], columnFractions: [0.3, 0.7] });
    const field = { id: 'f', name: 'n', kind: 'select', box: { x: 0, y: 0, width: 10, height: 10 } };
    expect(sanitizePage({ formFields: [{ ...field, options: 'many' }, { ...field, options: [{ label: 'A', value: 'a' }, 7] }] }, id).formFields).toEqual([
      { ...field, options: [] },
      { ...field, options: [{ label: 'A', value: 'a' }] },
    ]);
    const rich = { blocks: [{ runs: [{ text: 'hi', bold: true }] }] };
    expect(sanitizeMedia({ ...box, kind: 'text', text: 'hi', rich })).toMatchObject({ rich });
    expect(sanitizeMedia({ ...box, kind: 'text', text: 'hi', rich: { blocks: [{ runs: 'hi' }] } })).not.toHaveProperty('rich');
    // Pictures of files written before notes and tables existed had no kind.
    expect(sanitizeMedia({ ...box, src: 'data:image/png;base64,AAAA' }, true)).toMatchObject({ kind: 'image' });
  });

  it('opens a note whose document is half nonsense, as far as it can be', () => {
    const doc = open({
      version: 1,
      id: null,
      title: { toString: 'x' },
      zoom: 'big',
      activePageIndex: 99,
      cover: 'leather',
      pdfSources: { s: { data: '!!! not base64 !!!' }, t: 'nope' },
      pages: [{ id: 'a', strokes: [good] }, { id: 'a' }, 17, { id: 'b', template: 'pdf', pdf: { sourceId: 'gone', pageIndex: 0, viewBox: [0, 0, 600, 800], rotation: 0, scale: 1 } }],
    });
    expect(doc.title).toBe('Untitled note');
    expect(doc.id).toMatch(/^doc_/);
    expect(doc.cover).toBeUndefined();
    expect(doc.pages.length).toBe(4);
    expect(new Set(doc.pages.map((p) => p.id)).size).toBe(4);
    expect(doc.pages[0]!.strokes).toEqual([good]);
    expect(doc.pages[3]).toMatchObject({ template: 'blank' });
    expect(doc.pages[3]!.pdf).toBeUndefined();
    expect(doc.activePageIndex).toBe(3);
  });

  it('still refuses what is not a note at all', () => {
    expect(() => open({ version: 2, pages: [{}] })).toThrow(/version/);
    expect(() => open({ version: 1, pages: [] })).toThrow(/at least one page/);
    expect(() => open({ version: 1, pages: 'three' })).toThrow(/at least one page/);
    expect(() => open({ version: 1, pages: Array.from({ length: 20_001 }, () => ({})) })).toThrow(/more than can be opened/);
  });
});
