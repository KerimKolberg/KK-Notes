import { describe, expect, it } from 'vitest';
import { resolveDestination, resolveOutline, type OutlineDocument } from '../outline';

/** A PDF of `numPages` pages whose page objects are numbered 100 + index, with some named destinations. */
function fakeDoc(outline: unknown[] | null, named: Record<string, unknown[]> = {}, numPages = 10): OutlineDocument {
  return {
    numPages,
    getOutline: async () => outline as never,
    getDestination: async (id) => named[id] ?? null,
    getPageIndex: async (ref) => {
      if (ref.num < 100) throw new Error('not a page');
      return ref.num - 100;
    },
  };
}

const page = (i: number) => ({ num: 100 + i, gen: 0 });

describe('resolveDestination', () => {
  it('reads an explicit destination: the page, and how far down for /XYZ and /FitH', async () => {
    const doc = fakeDoc(null);
    expect(await resolveDestination(doc, [page(3), { name: 'XYZ' }, 72, 600, null])).toEqual({ pdfPageIndex: 3, top: 600 });
    expect(await resolveDestination(doc, [page(4), { name: 'FitH' }, 500])).toEqual({ pdfPageIndex: 4, top: 500 });
    expect(await resolveDestination(doc, [page(5), { name: 'Fit' }])).toEqual({ pdfPageIndex: 5, top: null });
    // XYZ with a null top keeps the page's top.
    expect(await resolveDestination(doc, [page(1), { name: 'XYZ' }, null, null, 0])).toEqual({ pdfPageIndex: 1, top: null });
  });

  it('looks a named destination up, and takes a bare page number', async () => {
    const doc = fakeDoc(null, { 'chapter.2': [page(7), { name: 'XYZ' }, 0, 700, 0] });
    expect(await resolveDestination(doc, 'chapter.2')).toEqual({ pdfPageIndex: 7, top: 700 });
    expect(await resolveDestination(doc, [2, { name: 'Fit' }])).toEqual({ pdfPageIndex: 2, top: null });
  });

  it('leads nowhere for a missing name, a bad reference or a page past the end', async () => {
    const doc = fakeDoc(null, {}, 5);
    expect(await resolveDestination(doc, 'nope')).toEqual({ pdfPageIndex: null, top: null });
    expect(await resolveDestination(doc, [{ num: 3, gen: 0 }, { name: 'Fit' }])).toEqual({ pdfPageIndex: null, top: null });
    expect(await resolveDestination(doc, [page(9), { name: 'Fit' }])).toEqual({ pdfPageIndex: null, top: null });
    expect(await resolveDestination(doc, null)).toEqual({ pdfPageIndex: null, top: null });
    expect(await resolveDestination(doc, [])).toEqual({ pdfPageIndex: null, top: null });
  });
});

describe('resolveOutline', () => {
  it('resolves every entry, nested ones included, and tidies titles', async () => {
    const doc = fakeDoc([
      { title: '1  Introduction', dest: [page(0), { name: 'Fit' }], items: [{ title: '1.1 Motivation', dest: [page(1), { name: 'XYZ' }, 0, 400, 0], items: [] }] },
      { title: '2 Fourier\nseries', dest: 'sec2', items: [] },
      { title: 'Website', dest: null, items: [] },
    ], { sec2: [page(4), { name: 'FitH' }, 650] });
    const outline = await resolveOutline(doc);
    expect(outline.map((i) => [i.title, i.pdfPageIndex, i.top])).toEqual([
      ['1 Introduction', 0, null],
      ['2 Fourier series', 4, 650],
      ['Website', null, null],
    ]);
    expect(outline[0]!.items[0]).toMatchObject({ title: '1.1 Motivation', pdfPageIndex: 1, top: 400 });
  });

  it('is empty for a PDF without one', async () => {
    expect(await resolveOutline(fakeDoc(null))).toEqual([]);
    expect(await resolveOutline(fakeDoc([]))).toEqual([]);
  });

  it('drops an untitled entry with nothing under it, and names one that has children', async () => {
    const outline = await resolveOutline(fakeDoc([
      { title: '', dest: [page(0), { name: 'Fit' }], items: [] },
      { title: '   ', dest: null, items: [{ title: 'Inner', dest: [page(2), { name: 'Fit' }], items: [] }] },
    ]));
    expect(outline).toHaveLength(1);
    expect(outline[0]!.title).toBe('Untitled');
    expect(outline[0]!.items[0]!.title).toBe('Inner');
  });
});
