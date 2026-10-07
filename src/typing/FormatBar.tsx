import { useEffect, useState, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  BringToFront,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Keyboard,
  List,
  Lock,
  LockOpen,
  ListChecks,
  ListOrdered,
  Minus,
  Plus,
  RemoveFormatting,
  SendToBack,
  Strikethrough,
  Subscript,
  Superscript,
  Trash2,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { TEXT_FONTS, TEXT_SIZES } from '../document/media';
import { countWords, richBaseOf, richOf, richPatch, type RichBase } from '../document/richText';
import { useDocumentStore } from '../document/store';
import { useToolStore } from '../document/toolStore';
import type { RichBlockKind, TextBox, TextFontId } from '../document/types';
import { chainBoxes, scheduleFlow } from './flow/engine';
import { formatAll, wholeBoxState, type FormatCommand, type FormatState } from './format';
import { keyLabel, isMac, SHORTCUT_GROUPS } from './shortcuts';
import { releaseController, showShortcuts, showWordCount, useTypingStore } from './typingStore';

/** Colours for text: ink colours, on paper. */
export const TEXT_COLORS: readonly string[] = ['#18181b', '#52525b', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777'];
/** Highlighter colours, light enough to read black text through. */
export const HIGHLIGHTS: readonly string[] = ['#fef08a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#fed7aa', '#e9d5ff'];

const KIND_LABELS: Readonly<Record<RichBlockKind, string>> = { p: 'Normal text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3' };

/** The selected text box, if a text box is selected. */
function useSelectedTextBox(): { pageId: string; box: TextBox } | null {
  const found = useDocumentStore(
    useShallow((s) => {
      const sel = s.selectedMedia;
      const item = sel ? s.document.pages.find((p) => p.id === sel.pageId)?.media.find((m) => m.id === sel.mediaId) : undefined;
      return { pageId: sel?.pageId ?? '', box: item?.kind === 'text' ? item : null };
    }),
  );
  return found.box ? { pageId: found.pageId, box: found.box } : null;
}

/** A keyboard shortcut for a command, as the tooltip shows it. */
function shortcutFor(label: string): string | undefined {
  for (const group of SHORTCUT_GROUPS) {
    const found = group.shortcuts.find((s) => s.label === label);
    if (found) return keyLabel(found.keys[0]!, isMac());
  }
  return undefined;
}

/**
 * Formatting for typed text, like a word processor's toolbar: docked at the top of the pages while a text box
 * is being typed in or is selected.
 *
 * Being typed in, a command acts on the selection (or on what is typed next); with the box only selected, it
 * acts on the whole box (`format.ts`). Its buttons take no focus, so the caret stays in the text.
 */
export function FormatBar() {
  const selected = useSelectedTextBox();
  const { controller, format, selectedText } = useTypingStore(
    useShallow((s) => ({ controller: s.controller, format: s.format, selectedText: s.selectedText })),
  );
  const tool = useToolStore((s) => s.settings.tool);
  const readOnly = useDocumentStore((s) => s.readOnly);
  // Page text counts as one text, all its pages.
  const chainWords = useDocumentStore((s) =>
    selected?.box.flow ? chainBoxes(s.document.pages, selected.pageId).reduce((n, c) => n + countWords(c.box.text), 0) : 0,
  );
  const [palette, setPalette] = useState<'color' | 'highlight' | null>(null);

  // The box being typed in is no longer it once something else is selected.
  useEffect(() => {
    if (controller && (!selected || selected.box.id !== controller.mediaId)) releaseController(controller.mediaId);
  }, [controller, selected]);

  if (!selected || tool !== 'select' || readOnly) return null;
  const { pageId, box } = selected;
  const editing = controller?.mediaId === box.id;
  const base: RichBase = richBaseOf(box);
  const state: FormatState = editing && format ? format : wholeBoxState(richOf(box), base);

  const apply = (command: FormatCommand): void => {
    if (editing && controller) {
      controller.exec(command);
      return;
    }
    // Page text is formatted as one text, every page of it; a text box on its own.
    const store = useDocumentStore.getState();
    const boxes = box.flow ? chainBoxes(store.document.pages, pageId) : [{ pageId, box }];
    const edits = boxes.map(({ pageId: p, box: b }) => {
      const whole = formatAll(richOf(b), richBaseOf(b), command);
      return { pageId: p, mediaId: b.id, patch: { ...richPatch(whole.rich), ...(whole.base ?? {}) } as Partial<TextBox> };
    });
    store.editTexts(edits, 'format');
    if (box.flow && boxes[0]) scheduleFlow(boxes[0].pageId);
  };

  const words = box.flow ? chainWords : countWords(box.text);
  const selectedWords = editing && selectedText ? countWords(selectedText) : null;

  return (
    <div
      className="absolute inset-x-0 top-0 z-30 border-b border-zinc-200 bg-white/95 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      role="toolbar"
      aria-label="Text formatting"
      data-format-bar
      // Pressing a button must not take the caret out of the text.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <div className="flex items-center gap-1 overflow-x-auto px-2 py-1 [scrollbar-width:thin]">
        <select
          aria-label="Paragraph style"
          data-format-kind
          className={SELECT}
          value={state.kind}
          onChange={(e) => apply({ type: 'kind', value: e.target.value as RichBlockKind })}
        >
          {(Object.keys(KIND_LABELS) as RichBlockKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <select
          aria-label="Font"
          data-format-font
          className={SELECT}
          value={state.font}
          onChange={(e) => apply({ type: 'font', value: e.target.value as TextFontId })}
        >
          {TEXT_FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.label}
            </option>
          ))}
        </select>
        <Button icon={Minus} label="Smaller text" onClick={() => apply({ type: 'grow', by: -1 })} data={{ 'data-format-grow': '-1' }} />
        <select
          aria-label="Text size"
          data-format-size
          className={`${SELECT} w-16 tabular-nums`}
          value={TEXT_SIZES.includes(Math.round(state.size)) ? Math.round(state.size) : ''}
          onChange={(e) => apply({ type: 'size', value: Number(e.target.value) })}
        >
          {!TEXT_SIZES.includes(Math.round(state.size)) && <option value="">{Math.round(state.size)}</option>}
          {TEXT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <Button icon={Plus} label="Bigger text" onClick={() => apply({ type: 'grow', by: 1 })} data={{ 'data-format-grow': '1' }} />
        <Divider />
        <Button icon={Bold} label="Bold" active={state.bold} onClick={() => apply({ type: 'toggle', mark: 'bold' })} data={{ 'data-format-toggle': 'bold' }} />
        <Button icon={Italic} label="Italic" active={state.italic} onClick={() => apply({ type: 'toggle', mark: 'italic' })} data={{ 'data-format-toggle': 'italic' }} />
        <Button icon={Underline} label="Underline" active={state.underline} onClick={() => apply({ type: 'toggle', mark: 'underline' })} data={{ 'data-format-toggle': 'underline' }} />
        <Button icon={Strikethrough} label="Strikethrough" active={state.strike} onClick={() => apply({ type: 'toggle', mark: 'strike' })} data={{ 'data-format-toggle': 'strike' }} />
        <Button icon={Superscript} label="Superscript" active={state.script === 'sup'} onClick={() => apply({ type: 'script', value: 'sup' })} data={{ 'data-format-script': 'sup' }} />
        <Button icon={Subscript} label="Subscript" active={state.script === 'sub'} onClick={() => apply({ type: 'script', value: 'sub' })} data={{ 'data-format-script': 'sub' }} />
        <Swatch
          label="Text colour"
          color={state.color}
          open={palette === 'color'}
          onClick={() => setPalette(palette === 'color' ? null : 'color')}
          data={{ 'data-format-color-open': '' }}
        >
          <span className="text-sm font-bold" style={{ color: state.color }}>
            A
          </span>
        </Swatch>
        <Swatch
          label="Highlight"
          color={state.highlight ?? 'transparent'}
          open={palette === 'highlight'}
          onClick={() => setPalette(palette === 'highlight' ? null : 'highlight')}
          data={{ 'data-format-highlight-open': '' }}
        >
          <Highlighter size={15} aria-hidden="true" />
        </Swatch>
        <Divider />
        <Button icon={AlignLeft} label="Align left" active={state.align === 'left'} onClick={() => apply({ type: 'align', value: 'left' })} data={{ 'data-format-align': 'left' }} />
        <Button icon={AlignCenter} label="Centre" active={state.align === 'center'} onClick={() => apply({ type: 'align', value: 'center' })} data={{ 'data-format-align': 'center' }} />
        <Button icon={AlignRight} label="Align right" active={state.align === 'right'} onClick={() => apply({ type: 'align', value: 'right' })} data={{ 'data-format-align': 'right' }} />
        <Button icon={AlignJustify} label="Justify" active={state.align === 'justify'} onClick={() => apply({ type: 'align', value: 'justify' })} data={{ 'data-format-align': 'justify' }} />
        <Divider />
        <Button icon={List} label="Bulleted list" active={state.list === 'bullet'} onClick={() => apply({ type: 'list', value: 'bullet' })} data={{ 'data-format-list': 'bullet' }} />
        <Button icon={ListOrdered} label="Numbered list" active={state.list === 'number'} onClick={() => apply({ type: 'list', value: 'number' })} data={{ 'data-format-list': 'number' }} />
        <Button icon={ListChecks} label="Checklist" active={state.list === 'check'} onClick={() => apply({ type: 'list', value: 'check' })} data={{ 'data-format-list': 'check' }} />
        <Button icon={IndentDecrease} label="Indent less" onClick={() => apply({ type: 'indent', by: -1 })} data={{ 'data-format-indent': '-1' }} />
        <Button icon={IndentIncrease} label="Indent" onClick={() => apply({ type: 'indent', by: 1 })} data={{ 'data-format-indent': '1' }} />
        <Button icon={RemoveFormatting} label="Clear formatting" onClick={() => apply({ type: 'clear' })} data={{ 'data-format-clear': '' }} />
        <Divider />
        <button
          type="button"
          className="h-8 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium tabular-nums text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          onClick={() => showWordCount()}
          title={`Word count (${shortcutFor('Word count') ?? ''})`}
          data-word-count-button
        >
          {selectedWords !== null ? `${selectedWords} of ${words} words` : `${words} ${words === 1 ? 'word' : 'words'}`}
        </button>
        <Button icon={Keyboard} label="Keyboard shortcuts" onClick={() => showShortcuts()} data={{ 'data-shortcuts-button': '' }} />
        {!box.flow && (
          <>
            <Divider />
            <Button
              icon={box.locked ? Lock : LockOpen}
              label={box.locked ? 'Unlock' : 'Lock in place'}
              active={box.locked === true}
              onClick={() => useDocumentStore.getState().updateMedia(pageId, box.id, { locked: !box.locked })}
              data={{ 'data-media-lock': '' }}
            />
            <Button icon={BringToFront} label="Bring to front" onClick={() => useDocumentStore.getState().bringMediaToFront(pageId, box.id)} data={{ 'data-text-front': '' }} />
            <Button icon={SendToBack} label="Send to back" onClick={() => useDocumentStore.getState().sendMediaToBack(pageId, box.id)} data={{ 'data-text-back': '' }} />
            <Button icon={Trash2} label="Delete text box" onClick={() => useDocumentStore.getState().removeMedia(pageId, box.id)} data={{ 'data-text-delete': '' }} />
          </>
        )}
      </div>
      {palette && (
        <div className="flex items-center gap-1.5 border-t border-zinc-200 px-2 py-1.5 dark:border-zinc-800" data-format-palette={palette}>
          {(palette === 'color' ? TEXT_COLORS : HIGHLIGHTS).map((color) => (
            <button
              key={color}
              type="button"
              className="h-6 w-6 shrink-0 rounded-full ring-1 ring-zinc-300 hover:ring-2 hover:ring-blue-500 dark:ring-zinc-600"
              style={{ background: color }}
              aria-label={`${palette === 'color' ? 'Text colour' : 'Highlight'} ${color}`}
              data-format-swatch={color}
              onClick={() => {
                apply(palette === 'color' ? { type: 'color', value: color } : { type: 'highlight', value: color });
                setPalette(null);
              }}
            />
          ))}
          {palette === 'color' ? (
            <input
              type="color"
              aria-label="Another text colour"
              className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
              value={/^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#18181b'}
              onChange={(e) => apply({ type: 'color', value: e.target.value })}
            />
          ) : (
            <button
              type="button"
              className="h-6 shrink-0 rounded-md px-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              data-format-swatch="none"
              onClick={() => {
                apply({ type: 'highlight', value: null });
                setPalette(null);
              }}
            >
              None
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const SELECT =
  'h-8 shrink-0 rounded-md border border-zinc-200 bg-white px-1.5 text-xs text-zinc-800 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100';

function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />;
}

interface ButtonProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly data?: Record<string, string>;
}

function Button({ icon: Icon, label, active = false, onClick, data }: ButtonProps) {
  const keys = shortcutFor(label);
  return (
    <button
      type="button"
      className={`inline-flex h-8 w-8 shrink-0 touch-manipulation items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
        active
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800'
      }`}
      aria-label={label}
      aria-pressed={active}
      title={keys ? `${label} (${keys})` : label}
      onClick={onClick}
      {...data}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

interface SwatchProps {
  readonly label: string;
  readonly color: string;
  readonly open: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly data?: Record<string, string>;
}

function Swatch({ label, color, open, onClick, children, data }: SwatchProps) {
  return (
    <button
      type="button"
      className={`relative inline-flex h-8 w-8 shrink-0 flex-col items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 ${
        open ? 'bg-zinc-100 dark:bg-zinc-800' : ''
      }`}
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onClick}
      {...data}
    >
      {children}
      <span className="absolute bottom-1 h-1 w-5 rounded-full ring-1 ring-zinc-300 dark:ring-zinc-600" style={{ background: color }} />
    </button>
  );
}
