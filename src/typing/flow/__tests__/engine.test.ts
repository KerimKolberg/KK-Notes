import { beforeEach, describe, expect, it } from 'vitest';
import { createTextBox } from '../../../document/media';
import { createDocument } from '../../../document/operations';
import { blockText } from '../../../document/richText';
import { useDocumentStore } from '../../../document/store';
import type { Page, RichBlock, TextBox } from '../../../document/types';
import { useTypingStore } from '../../typingStore';
import { setAboveInk, trimEnd, typeOnPage } from '../engine';
import { createFlowBox } from '../geometry';
import { flowBoxOf } from '../paginate';

const store = useDocumentStore;
const pages = (): readonly Page[] => store.getState().document.pages;

/** A page with page text on it, of these paragraphs. */
function withText(page: Page, texts: string[], extra: Partial<TextBox> = {}): Page {
  const blocks: RichBlock[] = texts.map((t) => ({ runs: t ? [{ text: t }] : [] }));
  return { ...page, media: [{ ...createFlowBox(page, 0), rich: { blocks }, text: texts.join('\n'), ...extra }] };
}

function load(...texts: (string[] | null)[]): void {
  const doc = createDocument(texts.length);
  store.getState().loadDocument({ ...doc, pages: doc.pages.map((p, i) => (texts[i] ? withText(p, texts[i]) : p)) }, null);
}

beforeEach(() => {
  store.getState().setReadOnly(false);
  useTypingStore.setState({ controller: null, focusRequest: null, keyboard: false });
});

describe('starting to type on a page', () => {
  it('puts the caret at the end of the page text there, or nearest a tap', () => {
    load(['Hello']);
    const box = typeOnPage(0);
    expect(box?.id).toBe(flowBoxOf(pages()[0])?.id);
    expect(useTypingStore.getState().focusRequest).toEqual({ mediaId: box!.id, at: 'end' });
    typeOnPage(0, { x: 10, y: 20 });
    expect(useTypingStore.getState().focusRequest?.at).toEqual({ x: 10, y: 20 });
  });

  it('starts text on a page after page text on a page of its own, so it stays there', () => {
    load(['On page one'], null);
    const box = typeOnPage(1)!;
    const first = flowBoxOf(pages()[1])!;
    expect(first.id).toBe(box.id);
    // A page break before it: it neither runs back to the end of page one's text, nor goes when it is empty.
    expect(first.rich?.blocks[0]?.pageBreak).toBe(true);
    // The text before it is untouched.
    expect(blockText(flowBoxOf(pages()[0])!.rich!.blocks[0]!)).toBe('On page one');
  });

  it('keeps the page text after it on its own page too, rather than pulling it up', () => {
    load(null, ['On page two']);
    typeOnPage(0);
    expect(flowBoxOf(pages()[0])?.rich?.blocks[0]?.pageBreak).toBeUndefined();
    const after = flowBoxOf(pages()[1])!;
    expect(after.rich?.blocks[0]?.pageBreak).toBe(true);
    expect(blockText(after.rich!.blocks[0]!)).toBe('On page two');
  });

  it('sets new page text like the page text beside it, in front of the drawings if that is', () => {
    const doc = createDocument(2);
    const front = withText(doc.pages[0]!, ['Front'], { aboveInk: true, fontFamily: 'serif', fontSize: 20 });
    store.getState().loadDocument({ ...doc, pages: [front, doc.pages[1]!] }, null);
    typeOnPage(1);
    const box = flowBoxOf(pages()[1])!;
    expect(box.aboveInk).toBe(true);
    expect(box.fontFamily).toBe('serif');
    expect(box.fontSize).toBe(20);
  });
});

describe('typed text in front of the drawings or behind them', () => {
  it('puts every page of page text in front together, as one step of Undo', () => {
    load(['One'], ['Two'], ['Three']);
    const box = flowBoxOf(pages()[1])!;
    setAboveInk(pages()[1]!.id, box.id, true);
    expect(pages().map((p) => flowBoxOf(p)?.aboveInk)).toEqual([true, true, true]);
    expect(store.getState().undoLast()).not.toBeNull();
    expect(pages().map((p) => flowBoxOf(p)?.aboveInk === true)).toEqual([false, false, false]);
  });

  it('puts a text box on its own in front, and back', () => {
    load(null);
    const page = pages()[0]!;
    store.getState().addMedia(page.id, { ...createTextBox(page.dimensions, 1), id: 'text_box', text: 'Box' });
    setAboveInk(page.id, 'text_box', true);
    const find = () => pages()[0]!.media.find((m) => m.id === 'text_box') as TextBox;
    expect(find().aboveInk).toBe(true);
    setAboveInk(page.id, 'text_box', false);
    expect(find().aboveInk).toBe(false);
  });

  it('asks for the caret back where it was, in the editor that starts again on the other layer', () => {
    load(['Hello']);
    const page = pages()[0]!;
    const box = flowBoxOf(page)!;
    useTypingStore.setState({
      controller: { pageId: page.id, mediaId: box.id, exec: () => {}, focus: () => {}, selection: () => ({ anchor: 2, head: 4 }) },
    });
    setAboveInk(page.id, box.id, true);
    expect(useTypingStore.getState().focusRequest).toEqual({ mediaId: box.id, at: 4, anchor: 2 });
  });

  it('changes nothing on a locked note', () => {
    load(['Hello']);
    const page = pages()[0]!;
    store.getState().setReadOnly(true);
    setAboveInk(page.id, flowBoxOf(page)!.id, true);
    expect(flowBoxOf(pages()[0])?.aboveInk).toBeUndefined();
  });
});

describe('empty lines at the end of page text', () => {
  const blocks = (i: number) => flowBoxOf(pages()[i])!.rich!.blocks.map((b) => blockText(b));

  it('go when the caret leaves, and are not a step of Undo', () => {
    load(['Hello', 'World', '', '', '']);
    const undos = store.getState().structureUndo.length;
    trimEnd(pages()[0]!.id);
    expect(blocks(0)).toEqual(['Hello', 'World']);
    expect(store.getState().structureUndo.length).toBe(undos);
    expect(flowBoxOf(pages()[0])!.text).toBe('Hello\nWorld');
  });

  it('stay between lines of text, and the first line stays even when empty', () => {
    load(['Hello', '', '', 'World']);
    trimEnd(pages()[0]!.id);
    expect(blocks(0)).toEqual(['Hello', '', '', 'World']);
    load(['', '', '']);
    trimEnd(pages()[0]!.id);
    expect(blocks(0)).toEqual(['']);
  });

  it('stay where the text goes on to the next page: there they are lines of it', () => {
    load(['Hello', '', ''], ['more']);
    trimEnd(pages()[0]!.id);
    expect(blocks(0)).toEqual(['Hello', '', '']);
  });

  it('go before a page that starts a page of its own', () => {
    load(['Hello', '', ''], null);
    typeOnPage(1);
    trimEnd(pages()[0]!.id);
    expect(blocks(0)).toEqual(['Hello']);
  });
});
