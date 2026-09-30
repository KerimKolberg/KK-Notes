import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  borrowSelectionTool,
  borrowedToolPending,
  handBackTool,
  isSelectionTool,
  notePenContact,
  resetToolBorrow,
  settleBorrowedTool,
} from '../toolBorrow';
import { cancelBarrelButton, consumeBarrelButton, noteBarrelButton, resetBarrelButton } from '../stylusBarrel';
import { useDocumentStore } from '../store';
import { useToolStore } from '../toolStore';
import { DEFAULT_STYLUS_SETTINGS } from '../../inking/constants';
import { BARREL_CLICK_MS } from '../../inking/engine/barrelButton';
import type { ToolType } from '../../inking/types';

const SELECTION = { pageId: 'page-1', strokeIds: ['a', 'b'] };

const tool = (): ToolType => useToolStore.getState().settings.tool;
const select = (): void => useDocumentStore.setState({ lassoSelection: SELECTION });
const dismiss = (): void => useDocumentStore.getState().clearLassoSelection();
const choose = (next: ToolType): void => useToolStore.getState().update({ tool: next });

beforeEach(() => {
  resetToolBorrow();
  resetBarrelButton();
  useDocumentStore.setState({ lassoSelection: null });
  // The mapping is saved between launches, so a test that changes it must not leak.
  useToolStore.getState().update({ stylus: DEFAULT_STYLUS_SETTINGS });
  choose('pen');
});

afterEach(() => {
  resetToolBorrow();
  resetBarrelButton();
  vi.useRealTimers();
});

describe('a lasso borrowed by a button being drawn with the second button', () => {
  it('switches to the lasso and remembers the pen', () => {
    borrowSelectionTool('lasso');
    expect(tool()).toBe('lasso');
    expect(borrowedToolPending()).toBe(true);
  });

  it('is kept once the loop has selected something, so the selection can be used', () => {
    borrowSelectionTool('lasso');
    select();
    notePenContact(false);
    settleBorrowedTool();
    expect(tool()).toBe('lasso');
  });

  it('goes back to what it was when the selection is dismissed', () => {
    borrowSelectionTool('lasso');
    select();
    notePenContact(false);
    settleBorrowedTool();
    dismiss();
    expect(tool()).toBe('pen');
    expect(borrowedToolPending()).toBe(false);
  });

  it('goes back at once when the loop selects nothing', () => {
    borrowSelectionTool('lasso');
    notePenContact(false);
    settleBorrowedTool();
    expect(tool()).toBe('pen');
  });

  it('is not handed back in the middle of a loop, when a new one clears the old selection', () => {
    borrowSelectionTool('lasso');
    select();
    notePenContact(false);
    settleBorrowedTool();
    // The next loop starts: the pen goes down and the old selection is cleared.
    notePenContact(true);
    dismiss();
    expect(tool()).toBe('lasso');
    // ... and it closes around something new.
    select();
    notePenContact(false);
    settleBorrowedTool();
    expect(tool()).toBe('lasso');
  });

  it('forgets the borrow if the user picks another tool, and never switches back on them', () => {
    borrowSelectionTool('lasso');
    select();
    notePenContact(false);
    settleBorrowedTool();
    choose('highlighter');
    expect(borrowedToolPending()).toBe(false);
    dismiss();
    expect(tool()).toBe('highlighter');
  });

  it('does nothing when the lasso is already the selected tool', () => {
    choose('lasso');
    borrowSelectionTool('lasso');
    expect(borrowedToolPending()).toBe(false);
    expect(tool()).toBe('lasso');
  });

  it('is only for selection tools', () => {
    borrowSelectionTool('eraser-stroke');
    expect(tool()).toBe('pen');
    expect(borrowedToolPending()).toBe(false);
    expect(isSelectionTool('lasso')).toBe(true);
    expect(isSelectionTool('eraser-stroke')).toBe(false);
  });
});

describe('a held button being let go', () => {
  it('hands an eraser straight back', () => {
    choose('eraser-stroke');
    handBackTool('eraser-stroke', 'pen');
    expect(tool()).toBe('pen');
  });

  it('hands a lasso straight back if it selected nothing', () => {
    choose('lasso');
    handBackTool('lasso', 'pen');
    expect(tool()).toBe('pen');
  });

  it('keeps a lasso that has a selection, until it is dismissed', () => {
    choose('lasso');
    select();
    handBackTool('lasso', 'pen');
    expect(tool()).toBe('lasso');
    dismiss();
    expect(tool()).toBe('pen');
  });

  it('keeps a lasso whose loop is still being drawn, and settles when the pen lifts', () => {
    choose('lasso');
    notePenContact(true);
    handBackTool('lasso', 'pen');
    expect(tool()).toBe('lasso');
    // The loop closes around something.
    select();
    notePenContact(false);
    settleBorrowedTool();
    expect(tool()).toBe('lasso');
  });

  it('gives an unfinished, empty loop back when the pen lifts', () => {
    choose('lasso');
    notePenContact(true);
    handBackTool('lasso', 'pen');
    notePenContact(false);
    settleBorrowedTool();
    expect(tool()).toBe('pen');
  });

  it('has nothing to hand back when the lasso was the tool already', () => {
    choose('lasso');
    select();
    handBackTool('lasso', 'lasso');
    expect(borrowedToolPending()).toBe(false);
    expect(tool()).toBe('lasso');
  });
});

describe('the barrel button, held, mapped to the lasso', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    useToolStore.getState().update({ stylus: { ...useToolStore.getState().settings.stylus, holdTool: 'lasso' } });
  });

  it('takes the lasso after the hold delay', () => {
    noteBarrelButton(true);
    expect(tool()).toBe('pen');
    vi.advanceTimersByTime(BARREL_CLICK_MS + 10);
    expect(tool()).toBe('lasso');
  });

  it('leaves the selection in place when the button is let go, and hands the pen back when it is dismissed', () => {
    noteBarrelButton(true);
    vi.advanceTimersByTime(BARREL_CLICK_MS + 10);
    notePenContact(true);
    select();
    notePenContact(false);
    noteBarrelButton(false);
    expect(tool()).toBe('lasso');
    dismiss();
    expect(tool()).toBe('pen');
  });

  it('gives the pen back on release when nothing was selected', () => {
    noteBarrelButton(true);
    vi.advanceTimersByTime(BARREL_CLICK_MS + 10);
    noteBarrelButton(false);
    expect(tool()).toBe('pen');
  });

  it('gives the pen back when the pen leaves range mid-hold and nothing is selected', () => {
    noteBarrelButton(true);
    vi.advanceTimersByTime(BARREL_CLICK_MS + 10);
    cancelBarrelButton();
    expect(tool()).toBe('pen');
  });
});

describe('the barrel button, held, mapped to an eraser (the shipped default)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  it('is an eraser while held and the pen again the moment it is let go', () => {
    expect(useToolStore.getState().settings.stylus.holdTool).toBe('eraser-stroke');
    noteBarrelButton(true);
    vi.advanceTimersByTime(BARREL_CLICK_MS + 10);
    expect(tool()).toBe('eraser-stroke');
    noteBarrelButton(false);
    expect(tool()).toBe('pen');
  });
});

describe('a quick swipe with the barrel button held', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  it('does not toggle the tool, however soon the button is let go', () => {
    expect(tool()).toBe('pen');
    noteBarrelButton(true);
    vi.advanceTimersByTime(80);
    // The tip touches the page with the button down: this press is a stroke.
    consumeBarrelButton();
    vi.advanceTimersByTime(80);
    noteBarrelButton(false);
    expect(tool()).toBe('pen');
  });

  it('does not borrow a tool part-way through either', () => {
    noteBarrelButton(true);
    consumeBarrelButton();
    vi.advanceTimersByTime(BARREL_CLICK_MS * 3);
    expect(tool()).toBe('pen');
    noteBarrelButton(false);
    expect(tool()).toBe('pen');
  });

  it('is still a click when nothing touched the page', () => {
    noteBarrelButton(true);
    vi.advanceTimersByTime(80);
    noteBarrelButton(false);
    // The shipped pair is pen and the stroke eraser.
    expect(tool()).toBe('eraser-stroke');
  });
});
