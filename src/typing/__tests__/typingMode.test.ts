import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../../document/operations';
import { useDocumentStore } from '../../document/store';
import { useToolStore } from '../../document/toolStore';
import { flowBoxOf } from '../flow/paginate';
import { insertTextBox, startTyping, stopTyping, typeAt } from '../typingMode';
import { useTypingStore } from '../typingStore';

const doc = () => useDocumentStore.getState().document;
const tool = () => useToolStore.getState().settings.tool;

beforeEach(() => {
  useDocumentStore.getState().setReadOnly(false);
  useDocumentStore.getState().loadDocument(createDocument(2), null);
  useTypingStore.setState({ controller: null, focusRequest: null, keyboard: false, returnTool: 'pen' });
  useToolStore.getState().update({ tool: 'pen' });
});

describe('the keyboard button', () => {
  it('turns the toolbar into the text toolbar, takes the select tool and puts the caret in the page in view', () => {
    useDocumentStore.getState().setActivePage(1);
    startTyping();
    expect(useTypingStore.getState().keyboard).toBe(true);
    expect(tool()).toBe('select');
    const box = flowBoxOf(doc().pages[1]);
    expect(box).toBeTruthy();
    expect(useTypingStore.getState().focusRequest).toEqual({ mediaId: box!.id, at: 'end' });
    expect(useDocumentStore.getState().selectedMedia).toEqual({ pageId: doc().pages[1]!.id, mediaId: box!.id });
  });

  it('goes back, with the pen button, to the tool that was writing before', () => {
    useToolStore.getState().update({ tool: 'highlighter' });
    startTyping();
    stopTyping();
    expect(useTypingStore.getState().keyboard).toBe(false);
    expect(tool()).toBe('highlighter');
    expect(useDocumentStore.getState().selectedMedia).toBeNull();
  });

  it('goes back to the pen from a tool that does not write', () => {
    useToolStore.getState().update({ tool: 'lasso' });
    startTyping();
    stopTyping();
    expect(tool()).toBe('pen');
  });

  it('does nothing on a locked note', () => {
    useDocumentStore.getState().setReadOnly(true);
    startTyping();
    expect(useTypingStore.getState().keyboard).toBe(false);
    expect(tool()).toBe('pen');
  });
});

describe('typing on a page', () => {
  it('puts the caret where a page was tapped, starting its text if it has none', () => {
    const page = doc().pages[0]!;
    typeAt(page.id, 120, 340);
    const box = flowBoxOf(doc().pages[0]);
    expect(useTypingStore.getState().focusRequest).toEqual({ mediaId: box!.id, at: { x: 120, y: 340 } });
  });

  it('puts a new text box on the page in view, with the caret in it, under the select tool', () => {
    insertTextBox();
    const page = doc().pages[doc().activePageIndex]!;
    const box = page.media.find((m) => m.kind === 'text' && !m.flow);
    expect(box).toBeTruthy();
    expect(useTypingStore.getState().focusRequest).toEqual({ mediaId: box!.id, at: 'end' });
    expect(tool()).toBe('select');
  });
});
