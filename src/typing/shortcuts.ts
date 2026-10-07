/**
 * The keyboard, as Word and Google Docs have taught everyone to use it: one table that the editor's keymap is
 * built from and the shortcuts sheet (Ctrl+/) shows, so the sheet cannot promise a key that does nothing.
 *
 * Keys are written as ProseMirror names them: `Mod` is Ctrl (⌘ on a Mac), and `Shift-8` is what the key with an
 * 8 on it sends with Shift held — ProseMirror reads the key's own character, so it works on any layout that
 * has the digit there.
 */
import type { FormatCommand } from './format';

export type ShortcutAction =
  | FormatCommand
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'wordCount' }
  | { readonly type: 'help' }
  | { readonly type: 'leave' }
  | { readonly type: 'tick' }
  | { readonly type: 'pageBreak' };

export interface Shortcut {
  readonly label: string;
  /** Every key that does it; the first is the one shown first. */
  readonly keys: readonly string[];
  /** What the keymap does for it; absent for what the editor does by itself (it is only listed). */
  readonly action?: ShortcutAction;
  /** When it applies, if not everywhere in a box. */
  readonly note?: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly shortcuts: readonly Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Text',
    shortcuts: [
      { label: 'Bold', keys: ['Mod-b'], action: { type: 'toggle', mark: 'bold' } },
      { label: 'Italic', keys: ['Mod-i'], action: { type: 'toggle', mark: 'italic' } },
      { label: 'Underline', keys: ['Mod-u'], action: { type: 'toggle', mark: 'underline' } },
      { label: 'Strikethrough', keys: ['Alt-Shift-5', 'Mod-Shift-x'], action: { type: 'toggle', mark: 'strike' } },
      { label: 'Superscript', keys: ['Mod-.', 'Mod-Shift-='], action: { type: 'script', value: 'sup' } },
      { label: 'Subscript', keys: ['Mod-,', 'Mod-='], action: { type: 'script', value: 'sub' } },
      { label: 'Bigger text', keys: ['Mod-Shift-.', 'Mod-]'], action: { type: 'grow', by: 1 } },
      { label: 'Smaller text', keys: ['Mod-Shift-,', 'Mod-['], action: { type: 'grow', by: -1 } },
      { label: 'Clear formatting', keys: ['Mod-\\', 'Mod-Space'], action: { type: 'clear' } },
    ],
  },
  {
    title: 'Paragraphs',
    shortcuts: [
      { label: 'Normal text', keys: ['Mod-Alt-0'], action: { type: 'kind', value: 'p' } },
      { label: 'Heading 1', keys: ['Mod-Alt-1'], action: { type: 'kind', value: 'h1' } },
      { label: 'Heading 2', keys: ['Mod-Alt-2'], action: { type: 'kind', value: 'h2' } },
      { label: 'Heading 3', keys: ['Mod-Alt-3'], action: { type: 'kind', value: 'h3' } },
      { label: 'Align left', keys: ['Mod-l'], action: { type: 'align', value: 'left' } },
      { label: 'Centre', keys: ['Mod-e'], action: { type: 'align', value: 'center' } },
      { label: 'Align right', keys: ['Mod-r'], action: { type: 'align', value: 'right' } },
      { label: 'Justify', keys: ['Mod-j'], action: { type: 'align', value: 'justify' } },
      { label: 'Indent', keys: ['Mod-m'], action: { type: 'indent', by: 1 } },
      { label: 'Indent less', keys: ['Mod-Shift-m'], action: { type: 'indent', by: -1 } },
      { label: 'New line in the same paragraph', keys: ['Shift-Enter'] },
      { label: 'Start a new page', keys: ['Mod-Enter'], action: { type: 'pageBreak' }, note: 'page text' },
    ],
  },
  {
    title: 'Lists',
    shortcuts: [
      { label: 'Numbered list', keys: ['Mod-Shift-7'], action: { type: 'list', value: 'number' } },
      { label: 'Bulleted list', keys: ['Mod-Shift-8', 'Mod-Shift-l'], action: { type: 'list', value: 'bullet' } },
      { label: 'Checklist', keys: ['Mod-Shift-9'], action: { type: 'list', value: 'check' } },
      { label: 'Tick or untick', keys: ['Mod-Alt-Enter'], action: { type: 'tick' }, note: 'checklist' },
      { label: 'One level in', keys: ['Tab'], note: 'in a list' },
      { label: 'One level out', keys: ['Shift-Tab'], note: 'in a list' },
      { label: 'End the list', keys: ['Enter'], note: 'on an empty item' },
    ],
  },
  {
    title: 'As you type',
    shortcuts: [
      { label: 'Bulleted list', keys: ['- then space', '* then space'] },
      { label: 'Numbered list', keys: ['1. then space'] },
      { label: 'Checklist', keys: ['[] then space'] },
      { label: 'Heading 1, 2, 3', keys: ['# then space', '## then space', '### then space'] },
      { label: 'Dash —', keys: ['--'] },
      { label: 'Ellipsis …', keys: ['...'] },
      { label: 'Undo the last of these', keys: ['Backspace'], note: 'straight after' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { label: 'Undo', keys: ['Mod-z'], action: { type: 'undo' } },
      { label: 'Redo', keys: ['Mod-y', 'Mod-Shift-z'], action: { type: 'redo' } },
      { label: 'Select all in the box', keys: ['Mod-a'] },
      { label: 'Cut, copy, paste', keys: ['Mod-x', 'Mod-c', 'Mod-v'] },
      { label: 'Paste without formatting', keys: ['Mod-Shift-v'] },
      { label: 'Word count', keys: ['Mod-Shift-g', 'Mod-Shift-c'], action: { type: 'wordCount' } },
      { label: 'Find in the note', keys: ['Mod-f'] },
      { label: 'Keyboard shortcuts', keys: ['Mod-/'], action: { type: 'help' } },
      { label: 'Stop typing', keys: ['Escape'], action: { type: 'leave' } },
    ],
  },
  {
    title: 'Moving around',
    shortcuts: [
      { label: 'A word at a time', keys: ['Mod-ArrowLeft', 'Mod-ArrowRight'] },
      { label: 'Start or end of the line', keys: ['Home', 'End'] },
      { label: 'Start or end of the text', keys: ['Mod-Home', 'Mod-End'] },
      { label: 'Select as you move', keys: ['Shift-ArrowRight'], note: 'Shift with any of these' },
      { label: 'Next or previous page', keys: ['PageDown', 'PageUp'], note: 'page text' },
    ],
  },
];

/** Every shortcut that does something, by key. */
export function shortcutActions(): Map<string, ShortcutAction> {
  const out = new Map<string, ShortcutAction>();
  for (const group of SHORTCUT_GROUPS) {
    for (const shortcut of group.shortcuts) {
      if (!shortcut.action) continue;
      for (const key of shortcut.keys) out.set(key, shortcut.action);
    }
  }
  return out;
}

const NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Space: 'Space',
};

/** A key as the sheet shows it: `Ctrl+Shift+8`, or `⌘⇧8` on a Mac. */
export function keyLabel(key: string, mac: boolean): string {
  // Something typed rather than a key ("1. then space", "--"): as it is.
  if (key.includes(' ') || /^[^A-Za-z0-9]{2,}$/.test(key)) return key;
  const parts = key.split('-').map((part, i, all) => (part === '' && i === all.length - 1 ? '-' : part)).filter((p) => p !== '');
  // `Mod--` is "Mod" and "-".
  if (key.endsWith('--')) parts.push('-');
  const label = parts.map((part) => {
    if (part === 'Mod') return mac ? '⌘' : 'Ctrl';
    if (part === 'Alt') return mac ? '⌥' : 'Alt';
    if (part === 'Shift') return mac ? '⇧' : 'Shift';
    if (part.length === 1) return part.toUpperCase();
    return NAMES[part] ?? part;
  });
  return label.join(mac ? '' : '+');
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
