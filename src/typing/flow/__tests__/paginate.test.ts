import { describe, expect, it } from 'vitest';
import { createPage } from '../../../document/operations';
import { blockText } from '../../../document/richText';
import type { Page, RichBlock, TextBox } from '../../../document/types';
import { createFlowBox } from '../geometry';
import { flowBoxOf, reflow, type Fit, type FlowMeasurer } from '../paginate';

/**
 * A stand-in for the browser: every line holds `PER_LINE` characters, a paragraph is as many lines as it needs
 * (one if it is empty), and a box holds `LINES` lines.
 */
const PER_LINE = 10;
const LINES = 3;
const measurer: FlowMeasurer = {
  fit(blocks): Fit {
    let used = 0;
    for (let i = 0; i < blocks.length; i++) {
      const length = blockText(blocks[i]!).length;
      const lines = Math.max(1, Math.ceil(length / PER_LINE));
      if (used + lines <= LINES) {
        used += lines;
        continue;
      }
      const room = LINES - used;
      return { blocks: i, split: room > 0 && length > room * PER_LINE ? room * PER_LINE : null };
    }
    return { blocks: blocks.length, split: null };
  },
};

function pageWith(texts: string[] | null, extra: Partial<Page> = {}): Page {
  const page = createPage({}, 1);
  if (!texts) return { ...page, ...extra };
  const box = createFlowBox(page, 0);
  const blocks: RichBlock[] = texts.map((t) => (t.startsWith('>') ? { cont: true, runs: [{ text: t.slice(1) }] } : { runs: t ? [{ text: t }] : [] }));
  return { ...page, ...extra, media: [{ ...box, rich: { blocks }, text: texts.join('\n') }] };
}

const newPage = (after: Page): Page => {
  const page = createPage({ dimensions: after.dimensions }, 1);
  return { ...page, media: [createFlowBox(page, 0)] };
};

/** Each page's paragraphs, a continuation marked with `>`. */
function texts(pages: readonly Page[]): string[][] {
  return pages.map((p) => (flowBoxOf(p)?.rich?.blocks ?? []).map((b) => `${b.cont ? '>' : ''}${blockText(b)}`));
}

describe('text flowing from page to page', () => {
  it('pushes what does not fit on to the next page, splitting a paragraph between lines', () => {
    // 3 lines a page: "aaaa…" takes 2, "bbbb…" (25 characters) 3, so 1 of its lines stays.
    const pages = [pageWith(['a'.repeat(20), 'b'.repeat(25)]), pageWith([''])];
    const result = reflow({ pages, from: 0, measurer, newPage });
    expect(texts(result.pages)).toEqual([['a'.repeat(20), 'b'.repeat(10)], ['>' + 'b'.repeat(15)]]);
    expect(result.changed).toBe(true);
  });

  it('adds pages past the end of the chain for text that runs on', () => {
    const pages = [pageWith(['x'.repeat(75)])];
    const result = reflow({ pages, from: 0, measurer, newPage });
    expect(texts(result.pages)).toEqual([['x'.repeat(30)], ['>' + 'x'.repeat(30)], ['>' + 'x'.repeat(15)]]);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
  });

  it('brings text back when there is room again, joining a split paragraph, and takes away a page left empty', () => {
    const pages = [pageWith(['short']), pageWith(['>rest', 'next'])];
    const result = reflow({ pages, from: 0, measurer, newPage });
    expect(texts(result.pages)).toEqual([['shortrest', 'next']]);
  });

  it('leaves a page with anything else on it, even when its text has gone', () => {
    const ink = { strokes: [{} as never] };
    const pages = [pageWith(['short']), pageWith(['back'], ink)];
    const result = reflow({ pages, from: 0, measurer, newPage });
    expect(texts(result.pages)).toEqual([['short', 'back'], ['']]);
  });

  it('stops at the first page that needs nothing, and leaves the rest as they were', () => {
    // Full pages: a change on the first that does not change how many lines it takes moves nothing.
    const pages = [pageWith(['a'.repeat(30)]), pageWith(['b'.repeat(30)]), pageWith(['untouched'])];
    const result = reflow({ pages, from: 0, measurer, newPage });
    expect(result.changed).toBe(false);
    expect(result.pages).toBe(pages);
  });

  it('pulls back only what fits, a line at a time', () => {
    const pages = [pageWith(['one']), pageWith(['two', 'x'.repeat(20)]), pageWith(['untouched'])];
    const result = reflow({ pages, from: 0, measurer, newPage });
    // Page 1 has room for "two" and one line of the x's; the rest moves up behind them.
    expect(texts(result.pages)).toEqual([['one', 'two', 'x'.repeat(10)], ['>' + 'x'.repeat(10), 'untouched']]);
  });

  it('starts a paragraph marked as a page break on a page of its own', () => {
    const pages = [pageWith(['one'])];
    const box = flowBoxOf(pages[0])!;
    const withBreak: Page = {
      ...pages[0]!,
      media: [{ ...box, rich: { blocks: [{ runs: [{ text: 'one' }] }, { pageBreak: true, runs: [{ text: 'two' }] }] } } as TextBox],
    };
    const result = reflow({ pages: [withBreak], from: 0, measurer, newPage });
    expect(texts(result.pages)).toEqual([['one'], ['two']]);
    // …and it is not pulled back while it still is one.
    const again = reflow({ pages: result.pages, from: 0, measurer, newPage });
    expect(again.changed).toBe(false);
  });

  it('follows the caret to the page its text went to', () => {
    const pages = [pageWith(['a'.repeat(20), 'b'.repeat(25)])];
    // The caret after the 22nd b, which ends up 12 characters into the continuation on page 2.
    const result = reflow({ pages, from: 0, measurer, newPage, caret: { pageId: pages[0]!.id, block: 1, offset: 22 } });
    expect(result.caret).toEqual({ pageId: result.pages[1]!.id, block: 0, offset: 12 });
  });

  it('follows the caret back when text joins the page before', () => {
    const pages = [pageWith(['short']), pageWith(['>rest'])];
    const result = reflow({ pages, from: 1, measurer, newPage, caret: { pageId: pages[1]!.id, block: 0, offset: 2 } });
    expect(result.caret).toEqual({ pageId: pages[0]!.id, block: 0, offset: 7 });
  });

  it('does nothing for a page without page text', () => {
    const pages = [pageWith(null)];
    expect(reflow({ pages, from: 0, measurer, newPage }).changed).toBe(false);
  });
});
