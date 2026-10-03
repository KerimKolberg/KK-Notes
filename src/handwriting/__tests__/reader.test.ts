import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import { deserializeDocument, serializeDocument } from '../../document/serialization';
import { selectIsDirty, useDocumentStore } from '../../document/store';
import type { InkWord } from '../../document/types';
import { revealText } from '../../search/reveal';
import { useFlashStore } from '../../search/flashStore';
import { documentSources, searchSources } from '../../search/text';
import { inkKey } from '../inkText';
import { IDLE_MS, MAX_FAILURES, startHandwritingReader } from '../useHandwritingReader';

const s = () => useDocumentStore.getState();
const page = (i = 0) => s().document.pages[i]!;
const write = (pageIndex = 0, x = 10) => s().commitStroke(page(pageIndex).id, makeStroke([[x, 10], [x + 40, 30]]));
const words: InkWord[] = [{ text: 'Eigenvalues', x: 10, y: 10, width: 80, height: 20 }];

beforeEach(() => {
  s().setReadOnly(false);
  s().newDocument();
});

describe('setPageInkText', () => {
  it('puts the words on the page without marking a saved note as changed', () => {
    write();
    s().markSaved(null);
    expect(selectIsDirty(s())).toBe(false);
    s().setPageInkText(page().id, { key: inkKey(page().strokes), by: 'default', words });
    expect(page().inkText?.words[0]?.text).toBe('Eigenvalues');
    expect(selectIsDirty(s())).toBe(false);
  });

  it('leaves a changed note changed, and takes words away', () => {
    write();
    expect(selectIsDirty(s())).toBe(true);
    s().setPageInkText(page().id, { key: 'k', by: 'default', words });
    expect(selectIsDirty(s())).toBe(true);
    s().setPageInkText(page().id, null);
    expect(page().inkText).toBeUndefined();
  });

  it('works on a note locked for presenting, which is not an edit', () => {
    write();
    s().setReadOnly(true);
    s().setPageInkText(page().id, { key: 'k', by: 'default', words });
    expect(page().inkText).toBeDefined();
    s().setReadOnly(false);
  });

  it('is not undone: Undo takes the stroke back, and the words go stale with it', () => {
    write();
    s().setPageInkText(page().id, { key: inkKey(page().strokes), by: 'default', words });
    s().undo(page().id);
    expect(page().strokes).toHaveLength(0);
    expect(page().inkText?.key).not.toBe(inkKey(page().strokes));
  });
});

describe('saving the words', () => {
  it('writes them with the page and reads them back', () => {
    write();
    s().setPageInkText(page().id, { key: 'k1', by: 'default', words });
    const back = deserializeDocument(serializeDocument(s().document));
    expect(back.pages[0]!.inkText).toEqual({ key: 'k1', by: 'default', words });
  });

  it('drops a record that is not one', () => {
    const json = JSON.parse(serializeDocument(s().document));
    json.pages[0].inkText = { key: 1, words: 'no' };
    expect(deserializeDocument(JSON.stringify(json)).pages[0]!.inkText).toBeUndefined();
  });
});

describe('searching handwriting', () => {
  it('finds a phrase written along a line, and points at its word', () => {
    const pages = [{ id: 'p', inkText: { words: [{ text: 'series', x: 120, y: 10, width: 50, height: 20 }, { text: 'Fourier', x: 10, y: 10, width: 60, height: 20 }] } }];
    const sources = documentSources({ title: '', pages });
    expect(sources.map((x) => [x.kind, x.text])).toEqual([['ink', 'Fourier series']]);
    const [hit] = searchSources(sources, 'fourier series');
    expect(hit?.source.kind).toBe('ink');
    expect(hit?.source.spans?.[0]?.word.text).toBe('Fourier');
  });

  it('marks the word when a result is chosen, and scrolls down the page to it', () => {
    write();
    const low = { text: 'Matrix', x: 40, y: 500, width: 80, height: 20 };
    s().setPageInkText(page().id, { key: 'k', by: 'default', words: [low] });
    revealText({ pageIndex: 0, pageId: page().id, mediaId: null, kind: 'ink', box: low });
    expect(useFlashStore.getState().flash?.box).toEqual({ x: 40, y: 500, width: 80, height: 20 });
    expect(s().scrollWithin?.y).toBeGreaterThan(400);
    expect(s().scrollWithin?.y).toBeLessThan(500);
  });

  it('finds the word again for a result from the library, which comes without one', () => {
    write();
    s().setPageInkText(page().id, { key: 'k', by: 'default', words });
    useFlashStore.setState({ flash: null });
    revealText({ pageIndex: 0, pageId: page().id, mediaId: null, kind: 'ink' }, 'eigen');
    expect(useFlashStore.getState().flash?.box.x).toBe(10);
  });
});

describe('startHandwritingReader', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const quiet = () => vi.advanceTimersByTimeAsync(IDLE_MS + 50);

  it('reads a page once things are still, and not again until its writing changes', async () => {
    const recognize = vi.fn(async () => words);
    const stop = startHandwritingReader({ recognizer: null, recognize, penNearby: () => false });
    write();
    expect(recognize).not.toHaveBeenCalled();
    await quiet();
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(page().inkText?.words[0]?.text).toBe('Eigenvalues');
    expect(page().inkText?.by).toBe('default');
    await quiet();
    expect(recognize).toHaveBeenCalledTimes(1);
    write(0, 100);
    await quiet();
    expect(recognize).toHaveBeenCalledTimes(2);
    stop();
  });

  it('waits while a pen is near the screen', async () => {
    let near = true;
    const recognize = vi.fn(async () => words);
    const stop = startHandwritingReader({ recognizer: null, recognize, penNearby: () => near });
    write();
    await quiet();
    await quiet();
    expect(recognize).not.toHaveBeenCalled();
    near = false;
    await quiet();
    expect(recognize).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not put an old reading over writing that went on meanwhile', async () => {
    let release: (w: InkWord[]) => void = () => {};
    const recognize = vi.fn(() => new Promise<InkWord[]>((resolve) => (release = resolve)));
    const stop = startHandwritingReader({ recognizer: 'English', recognize, penNearby: () => false });
    write();
    await quiet();
    expect(recognize).toHaveBeenCalledTimes(1);
    write(0, 100);
    release(words);
    await vi.advanceTimersByTimeAsync(10);
    expect(page().inkText).toBeUndefined();
    await quiet();
    expect(recognize).toHaveBeenCalledTimes(2);
    release(words);
    await vi.advanceTimersByTimeAsync(10);
    expect(page().inkText?.by).toBe('English');
    stop();
  });

  it('takes the words away when the handwriting is gone, without asking the recogniser', async () => {
    const recognize = vi.fn(async () => words);
    const stop = startHandwritingReader({ recognizer: null, recognize, penNearby: () => false });
    write();
    await quiet();
    s().clearPage(page().id);
    await quiet();
    await quiet();
    expect(page().inkText).toBeUndefined();
    expect(recognize).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reads the page in view first, then the others', async () => {
    s().addPage('after', 0);
    s().addPage('after', 1);
    for (let i = 0; i < 3; i++) write(i);
    s().setActivePage(2);
    const order: string[] = [];
    const recognize = vi.fn(async () => {
      order.push(s().document.pages.findIndex((p) => !p.inkText).toString());
      return words;
    });
    const stop = startHandwritingReader({ recognizer: null, recognize, penNearby: () => false });
    await quiet();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(s().document.pages.every((p) => p.inkText)).toBe(true);
    // The first read was the page in view.
    expect(order[0]).toBe('0');
    stop();
  });

  it('stops after failing again and again, and says why', async () => {
    const recognize = vi.fn(async () => {
      throw new Error('no handwriting installed');
    });
    const onError = vi.fn();
    const stop = startHandwritingReader({ recognizer: null, recognize, penNearby: () => false, onError });
    s().addPage('after', 0);
    s().addPage('after', 1);
    s().addPage('after', 2);
    for (let i = 0; i < 4; i++) write(i);
    await quiet();
    await vi.advanceTimersByTimeAsync(2000);
    expect(recognize).toHaveBeenCalledTimes(MAX_FAILURES);
    expect(onError).toHaveBeenLastCalledWith('no handwriting installed', true);
    stop();
  });
});
