import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  BringToFront,
  Command,
  Heading,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Layers,
  List,
  ListChecks,
  ListOrdered,
  Lock,
  LockOpen,
  Minus,
  Plus,
  RemoveFormatting,
  SendToBack,
  Strikethrough,
  Subscript,
  Superscript,
  TextCursorInput,
  Trash2,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { TEXT_FONTS, TEXT_SIZES } from '../document/media';
import { countWords, richBaseOf, richOf, richPatch } from '../document/richText';
import { useDocumentStore } from '../document/store';
import type { RichAlign, RichBlockKind, TextBox, TextFontId } from '../document/types';
import { IconButton } from '../ui/IconButton';
import { Popover, type PopoverSide } from '../ui/Popover';
import { Tooltip } from '../ui/Tooltip';
import { chainBoxes, scheduleFlow, setAboveInk } from './flow/engine';
import { formatAll, wholeBoxState, type FormatCommand, type FormatState } from './format';
import { keyLabel, isMac, SHORTCUT_GROUPS } from './shortcuts';
import { insertTextBox } from './typingMode';
import { showShortcuts, showWordCount, useTypingStore } from './typingStore';

/** Colours for text: ink colours, on paper. */
export const TEXT_COLORS: readonly string[] = ['#18181b', '#52525b', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777'];
/** Highlighter colours, light enough to read black text through. */
export const HIGHLIGHTS: readonly string[] = ['#fef08a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#fed7aa', '#e9d5ff'];

const KIND_LABELS: Readonly<Record<RichBlockKind, string>> = { p: 'Normal text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3' };
const KIND_SIZES: Readonly<Record<RichBlockKind, string>> = { p: 'text-sm', h1: 'text-xl font-bold', h2: 'text-lg font-bold', h3: 'text-base font-semibold' };

const ALIGNS: readonly { readonly value: RichAlign; readonly label: string; readonly icon: LucideIcon }[] = [
  { value: 'left', label: 'Align left', icon: AlignLeft },
  { value: 'center', label: 'Centre', icon: AlignCenter },
  { value: 'right', label: 'Align right', icon: AlignRight },
  { value: 'justify', label: 'Justify', icon: AlignJustify },
];

type Picker = 'kind' | 'font' | 'size' | 'color' | 'highlight' | 'align';

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

export interface TextToolbarProps {
  /** Standing on end, docked to a side: one column. */
  readonly vertical: boolean;
  /** Which way its pickers open: away from the edge the toolbar is docked to. */
  readonly popSide: PopoverSide;
  /** A picker is open: the toolbar is in use, and must not slip away. */
  readonly onBusyChange?: (busy: boolean) => void;
}

/**
 * The text toolbar: what the toolbar becomes while typing (`typingMode.ts`), as Samsung Notes' does — checklist,
 * paragraph style, a text box, font and size first, then the rest a slide along.
 *
 * Being typed in, a command acts on the selection (or on what is typed next); with a box only selected, it acts on
 * the whole box (`format.ts`), and page text on every page of it. Its buttons take no focus, so the caret stays in
 * the text, and on a tablet the keyboard stays up.
 */
export function TextToolbar({ vertical, popSide, onBusyChange }: TextToolbarProps) {
  const selected = useSelectedTextBox();
  const { controller, format, selectedText } = useTypingStore(
    useShallow((s) => ({ controller: s.controller, format: s.format, selectedText: s.selectedText })),
  );
  const readOnly = useDocumentStore((s) => s.readOnly);
  // Page text counts as one text, all its pages.
  const chainWords = useDocumentStore((s) =>
    selected?.box.flow ? chainBoxes(s.document.pages, selected.pageId).reduce((n, c) => n + countWords(c.box.text), 0) : 0,
  );
  const [picker, setPicker] = useState<Picker | null>(null);
  useEffect(() => onBusyChange?.(picker !== null), [picker, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const close = useCallback(() => setPicker(null), []);
  const toggle = (next: Picker): void => setPicker((current) => (current === next ? null : next));

  const box = selected?.box ?? null;
  const pageId = selected?.pageId ?? '';
  const editing = box !== null && controller?.mediaId === box.id;
  const state: FormatState | null = box ? (editing && format ? format : wholeBoxState(richOf(box), richBaseOf(box))) : null;
  const off = box === null || readOnly;

  const apply = (command: FormatCommand): void => {
    if (!box) return;
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
  const pick = (command: FormatCommand): void => {
    apply(command);
    close();
  };

  const words = box ? (box.flow ? chainWords : countWords(box.text)) : 0;
  const selectedWords = editing && selectedText ? countWords(selectedText) : null;
  const wordsLabel = selectedWords !== null ? `${selectedWords} of ${words} words` : `${words} ${words === 1 ? 'word' : 'words'}`;
  const above = box?.aboveInk === true;
  const align = ALIGNS.find((a) => a.value === state?.align) ?? ALIGNS[0]!;
  const fontLabel = TEXT_FONTS.find((f) => f.id === state?.font)?.label ?? 'Font';
  const divider = (
    <span
      className={`shrink-0 bg-zinc-200 dark:bg-zinc-700 ${vertical ? 'my-0.5 h-px w-6' : 'mx-0.5 h-6 w-px'}`}
      aria-hidden="true"
    />
  );

  return (
    // `contents`: its buttons are the toolbar's own, laid out (and slid) with it.
    <div
      className="contents"
      data-format-bar
      // Pressing a button must not take the caret out of the text (nor, on a tablet, the keyboard away).
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <Toggle icon={ListChecks} label="Checklist" on={state?.list === 'check'} disabled={off} onClick={() => apply({ type: 'list', value: 'check' })} data={{ 'data-format-list': 'check' }} />
      <Anchor>
        <IconButton
          size="sm"
          icon={Heading}
          label="Paragraph style"
          hint={state ? KIND_LABELS[state.kind] : undefined}
          hasPopover
          active={picker === 'kind'}
          disabled={off}
          aria-haspopup="dialog"
          aria-expanded={picker === 'kind'}
          onClick={() => toggle('kind')}
          data-format-kind-open
        />
        <Popover open={picker === 'kind'} onClose={close} label="Paragraph style" side={popSide} align="center">
          <div className="flex w-44 flex-col gap-0.5" role="listbox" aria-label="Paragraph style">
            {(Object.keys(KIND_LABELS) as RichBlockKind[]).map((kind) => (
              <Choice key={kind} on={state?.kind === kind} onClick={() => pick({ type: 'kind', value: kind })} data={{ 'data-format-kind': kind }}>
                <span className={KIND_SIZES[kind]}>{KIND_LABELS[kind]}</span>
              </Choice>
            ))}
          </div>
        </Popover>
      </Anchor>
      <IconButton size="sm" icon={TextCursorInput} label="Text box" hint="a box of text to place anywhere" disabled={readOnly} onClick={() => insertTextBox()} data-text-box-insert />
      <Anchor>
        <Labelled label="Font" hint={fontLabel} on={picker === 'font'} disabled={off} onClick={() => toggle('font')} data={{ 'data-format-font-open': '' }}>
          <span style={{ fontFamily: TEXT_FONTS.find((f) => f.id === state?.font)?.css }}>Aa</span>
        </Labelled>
        <Popover open={picker === 'font'} onClose={close} label="Font" side={popSide} align="center">
          <div className="flex w-48 flex-col gap-0.5" role="listbox" aria-label="Font">
            {TEXT_FONTS.map((font) => (
              <Choice key={font.id} on={state?.font === font.id} onClick={() => pick({ type: 'font', value: font.id as TextFontId })} data={{ 'data-format-font': font.id }}>
                <span className="text-sm" style={{ fontFamily: font.css }}>
                  {font.label}
                </span>
              </Choice>
            ))}
          </div>
        </Popover>
      </Anchor>
      <Anchor>
        <Labelled label="Text size" hint={state ? `${Math.round(state.size)} pt` : undefined} on={picker === 'size'} disabled={off} onClick={() => toggle('size')} data={{ 'data-format-size-open': '' }}>
          <span className="tabular-nums" data-format-size-value>
            {state ? Math.round(state.size) : '–'}
          </span>
        </Labelled>
        <Popover open={picker === 'size'} onClose={close} label="Text size" side={popSide} align="center">
          <div className="flex w-48 flex-col gap-2">
            <div className="flex items-center justify-between gap-1">
              <IconButton size="sm" icon={Minus} label="Smaller text" disabled={off} onClick={() => apply({ type: 'grow', by: -1 })} data-format-grow="-1" />
              <span className="text-sm font-semibold tabular-nums">{state ? Math.round(state.size) : '–'}</span>
              <IconButton size="sm" icon={Plus} label="Bigger text" disabled={off} onClick={() => apply({ type: 'grow', by: 1 })} data-format-grow="1" />
            </div>
            <div className="grid grid-cols-4 gap-1" role="listbox" aria-label="Text sizes">
              {TEXT_SIZES.map((size) => (
                <Choice key={size} on={state !== null && Math.round(state.size) === size} onClick={() => pick({ type: 'size', value: size })} data={{ 'data-format-size': String(size) }} center>
                  <span className="tabular-nums">{size}</span>
                </Choice>
              ))}
            </div>
          </div>
        </Popover>
      </Anchor>
      {divider}
      <Toggle icon={Bold} label="Bold" on={state?.bold === true} disabled={off} onClick={() => apply({ type: 'toggle', mark: 'bold' })} data={{ 'data-format-toggle': 'bold' }} />
      <Toggle icon={Italic} label="Italic" on={state?.italic === true} disabled={off} onClick={() => apply({ type: 'toggle', mark: 'italic' })} data={{ 'data-format-toggle': 'italic' }} />
      <Toggle icon={Underline} label="Underline" on={state?.underline === true} disabled={off} onClick={() => apply({ type: 'toggle', mark: 'underline' })} data={{ 'data-format-toggle': 'underline' }} />
      <Toggle icon={Strikethrough} label="Strikethrough" on={state?.strike === true} disabled={off} onClick={() => apply({ type: 'toggle', mark: 'strike' })} data={{ 'data-format-toggle': 'strike' }} />
      <Anchor>
        <Labelled label="Text colour" on={picker === 'color'} disabled={off} onClick={() => toggle('color')} data={{ 'data-format-color-open': '' }}>
          <span className="flex flex-col items-center leading-none">
            <span className="text-sm font-bold">A</span>
            <span className="mt-0.5 h-1 w-4 rounded-full ring-1 ring-zinc-300 dark:ring-zinc-600" style={{ background: state?.color ?? '#18181b' }} />
          </span>
        </Labelled>
        <Popover open={picker === 'color'} onClose={close} label="Text colour" side={popSide} align="center">
          <Swatches
            colors={TEXT_COLORS}
            label="Text colour"
            current={state?.color ?? null}
            onPick={(color) => pick({ type: 'color', value: color })}
            extra={
              <input
                type="color"
                aria-label="Another text colour"
                className="h-7 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                value={state && /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#18181b'}
                onChange={(e) => apply({ type: 'color', value: e.target.value })}
              />
            }
          />
        </Popover>
      </Anchor>
      <Anchor>
        <Labelled label="Highlight" on={picker === 'highlight'} disabled={off} onClick={() => toggle('highlight')} data={{ 'data-format-highlight-open': '' }}>
          <span className="flex flex-col items-center leading-none">
            <Highlighter size={15} aria-hidden="true" />
            <span className="mt-0.5 h-1 w-4 rounded-full ring-1 ring-zinc-300 dark:ring-zinc-600" style={{ background: state?.highlight ?? 'transparent' }} />
          </span>
        </Labelled>
        <Popover open={picker === 'highlight'} onClose={close} label="Highlight" side={popSide} align="center">
          <Swatches
            colors={HIGHLIGHTS}
            label="Highlight"
            current={state?.highlight ?? null}
            onPick={(color) => pick({ type: 'highlight', value: color })}
            extra={
              <button
                type="button"
                className="h-7 shrink-0 rounded-md px-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                data-format-swatch="none"
                onClick={() => pick({ type: 'highlight', value: null })}
              >
                None
              </button>
            }
          />
        </Popover>
      </Anchor>
      {divider}
      <Toggle icon={List} label="Bulleted list" on={state?.list === 'bullet'} disabled={off} onClick={() => apply({ type: 'list', value: 'bullet' })} data={{ 'data-format-list': 'bullet' }} />
      <Toggle icon={ListOrdered} label="Numbered list" on={state?.list === 'number'} disabled={off} onClick={() => apply({ type: 'list', value: 'number' })} data={{ 'data-format-list': 'number' }} />
      <Anchor>
        <IconButton
          size="sm"
          icon={align.icon}
          label="Alignment"
          hint={align.label}
          hasPopover
          active={picker === 'align'}
          disabled={off}
          aria-haspopup="dialog"
          aria-expanded={picker === 'align'}
          onClick={() => toggle('align')}
          data-format-align-open
        />
        <Popover open={picker === 'align'} onClose={close} label="Alignment" side={popSide} align="center">
          <div className="flex gap-0.5" role="group" aria-label="Alignment">
            {ALIGNS.map((a) => (
              <Toggle key={a.value} icon={a.icon} label={a.label} on={state?.align === a.value} disabled={off} onClick={() => pick({ type: 'align', value: a.value })} data={{ 'data-format-align': a.value }} />
            ))}
          </div>
        </Popover>
      </Anchor>
      <Toggle icon={IndentDecrease} label="Indent less" disabled={off} onClick={() => apply({ type: 'indent', by: -1 })} data={{ 'data-format-indent': '-1' }} />
      <Toggle icon={IndentIncrease} label="Indent" disabled={off} onClick={() => apply({ type: 'indent', by: 1 })} data={{ 'data-format-indent': '1' }} />
      {divider}
      <Toggle icon={Superscript} label="Superscript" on={state?.script === 'sup'} disabled={off} onClick={() => apply({ type: 'script', value: 'sup' })} data={{ 'data-format-script': 'sup' }} />
      <Toggle icon={Subscript} label="Subscript" on={state?.script === 'sub'} disabled={off} onClick={() => apply({ type: 'script', value: 'sub' })} data={{ 'data-format-script': 'sub' }} />
      <Toggle icon={RemoveFormatting} label="Clear formatting" disabled={off} onClick={() => apply({ type: 'clear' })} data={{ 'data-format-clear': '' }} />
      {divider}
      <IconButton
        size="sm"
        icon={Layers}
        label={above ? 'Text in front of the drawings' : 'Text behind the drawings'}
        hint={above ? 'press to put it behind' : 'press to bring it in front'}
        active={above}
        disabled={off}
        onClick={() => box && setAboveInk(pageId, box.id, !above)}
        data-text-above-ink={above ? 'true' : 'false'}
      />
      {box && !box.flow && (
        <>
          <IconButton
            size="sm"
            icon={box.locked ? Lock : LockOpen}
            label={box.locked ? 'Unlock' : 'Lock in place'}
            active={box.locked === true}
            disabled={readOnly}
            onClick={() => useDocumentStore.getState().updateMedia(pageId, box.id, { locked: !box.locked })}
            data-media-lock
          />
          <IconButton size="sm" icon={BringToFront} label="Bring to front" disabled={readOnly} onClick={() => useDocumentStore.getState().bringMediaToFront(pageId, box.id)} data-text-front />
          <IconButton size="sm" icon={SendToBack} label="Send to back" disabled={readOnly} onClick={() => useDocumentStore.getState().sendMediaToBack(pageId, box.id)} data-text-back />
          <IconButton size="sm" icon={Trash2} label="Delete text box" tone="danger" disabled={readOnly} onClick={() => useDocumentStore.getState().removeMedia(pageId, box.id)} data-text-delete />
        </>
      )}
      {divider}
      <Tooltip label="Word count" hint={`${wordsLabel} · ${shortcutFor('Word count') ?? ''}`}>
        <button
          type="button"
          aria-label={`Word count: ${wordsLabel}`}
          className={`inline-flex h-9 shrink-0 touch-manipulation items-center justify-center whitespace-nowrap rounded-lg text-xs font-medium tabular-nums text-zinc-600 hover:bg-zinc-200/80 dark:text-zinc-300 dark:hover:bg-zinc-700/70 ${
            vertical ? 'w-9' : 'px-2'
          }`}
          onClick={() => showWordCount()}
          data-word-count-button
        >
          {vertical ? (selectedWords ?? words) : wordsLabel}
        </button>
      </Tooltip>
      <IconButton size="sm" icon={Command} label="Keyboard shortcuts" onClick={() => showShortcuts()} data-shortcuts-button />
    </div>
  );
}

/** Holds a picker's button and its popover together, as `Popover` needs. */
function Anchor({ children }: { children: ReactNode }) {
  return <div className="relative shrink-0">{children}</div>;
}

interface ToggleProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly on?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly data?: Record<string, string>;
}

/** A command button, with its keyboard shortcut in the tooltip. */
function Toggle({ icon, label, on = false, disabled = false, onClick, data }: ToggleProps) {
  const keys = shortcutFor(label);
  return <IconButton size="sm" icon={icon} label={label} hint={keys} active={on} disabled={disabled} onClick={onClick} {...data} />;
}

interface LabelledProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly on: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly data?: Record<string, string>;
  readonly children: ReactNode;
}

/** A picker's button that shows what is chosen — "Aa" in the font, the size — rather than an icon. */
function Labelled({ label, hint, on, disabled, onClick, data, children }: LabelledProps) {
  return (
    <Tooltip label={label} {...(hint ? { hint } : {})} disabled={on}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={on}
        disabled={disabled}
        className={`relative inline-flex h-9 min-w-9 shrink-0 touch-manipulation select-none items-center justify-center rounded-lg px-1 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:pointer-events-none disabled:opacity-35 ${
          on
            ? 'bg-blue-600 text-white ring-2 ring-blue-400/70 dark:bg-blue-500'
            : 'text-zinc-700 hover:bg-zinc-200/80 dark:text-zinc-200 dark:hover:bg-zinc-700/70'
        }`}
        onClick={onClick}
        {...data}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** One of a picker's choices. */
function Choice({ on, onClick, data, center = false, children }: { on: boolean; onClick: () => void; data?: Record<string, string>; center?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      className={`flex min-h-9 items-center rounded-lg px-2 text-left text-zinc-800 transition-colors dark:text-zinc-100 ${center ? 'justify-center' : ''} ${
        on ? 'bg-blue-100 text-blue-800 dark:bg-blue-500/25 dark:text-blue-100' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
      }`}
      onClick={onClick}
      {...data}
    >
      {children}
    </button>
  );
}

/** A picker of colours, and one more control after them (another colour, or none). */
function Swatches({ colors, label, current, onPick, extra }: { colors: readonly string[]; label: string; current: string | null; onPick: (color: string) => void; extra: ReactNode }) {
  return (
    <div className="flex w-max max-w-[15rem] flex-wrap items-center gap-1.5" data-format-palette={label === 'Highlight' ? 'highlight' : 'color'}>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className={`h-7 w-7 shrink-0 rounded-full ring-1 ring-zinc-300 hover:ring-2 hover:ring-blue-500 dark:ring-zinc-600 ${
            current?.toLowerCase() === color ? 'outline-2 outline-offset-2 outline-blue-500' : ''
          }`}
          style={{ background: color }}
          aria-label={`${label} ${color}`}
          data-format-swatch={color}
          onClick={() => onPick(color)}
        />
      ))}
      {extra}
    </div>
  );
}
