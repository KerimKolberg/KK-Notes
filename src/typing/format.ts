/**
 * What the format bar and the keyboard can do to typed text, and what it does to a whole box at once.
 *
 * In the editor a command acts on the selection, as a word processor's does (`editor/commands.ts`). With a box
 * selected but not being typed in, it acts on the whole box ({@link formatAll}): a mark on every run, a
 * paragraph style on every paragraph, and the font, size and colour as the box's own — with any a run had of its
 * own taken off, so the whole box really is in what was chosen.
 */
import { TEXT_SIZES } from '../document/media';
import { clampIndent, HEADING_SCALE, normalizeRuns, type RichBase } from '../document/richText';
import type { RichAlign, RichBlock, RichBlockKind, RichList, RichRun, RichScript, RichText, TextFontId } from '../document/types';

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike';

export type FormatCommand =
  | { readonly type: 'toggle'; readonly mark: MarkName }
  | { readonly type: 'script'; readonly value: RichScript }
  | { readonly type: 'color'; readonly value: string }
  | { readonly type: 'highlight'; readonly value: string | null }
  | { readonly type: 'size'; readonly value: number }
  | { readonly type: 'grow'; readonly by: 1 | -1 }
  | { readonly type: 'font'; readonly value: TextFontId }
  | { readonly type: 'kind'; readonly value: RichBlockKind }
  | { readonly type: 'list'; readonly value: RichList }
  | { readonly type: 'indent'; readonly by: 1 | -1 }
  | { readonly type: 'align'; readonly value: RichAlign }
  | { readonly type: 'clear' };

/** How the text where the caret is (or all of a selection) is set, for the format bar to show. */
export interface FormatState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly script: RichScript | null;
  readonly color: string;
  readonly highlight: string | null;
  /** The size the text is in, its own or its paragraph's. */
  readonly size: number;
  readonly font: TextFontId;
  readonly kind: RichBlockKind;
  readonly list: RichList | null;
  readonly align: RichAlign;
  readonly indent: number;
}

/** The next size up or down the list the format bar offers, from any size. */
export function nextSize(current: number, by: 1 | -1): number {
  if (by > 0) return TEXT_SIZES.find((s) => s > current + 0.01) ?? TEXT_SIZES[TEXT_SIZES.length - 1]!;
  return [...TEXT_SIZES].reverse().find((s) => s < current - 0.01) ?? TEXT_SIZES[0]!;
}

function allRuns(rich: RichText): RichRun[] {
  return rich.blocks.flatMap((b) => b.runs);
}

function mapRuns(rich: RichText, fn: (run: RichRun) => RichRun): RichText {
  return { blocks: rich.blocks.map((b) => ({ ...b, runs: normalizeRuns(b.runs.map(fn)) })) };
}

function mapBlocks(rich: RichText, fn: (block: RichBlock) => RichBlock): RichText {
  return { blocks: rich.blocks.map(fn) };
}

function without<K extends keyof RichRun>(run: RichRun, key: K): RichRun {
  const { [key]: _gone, ...rest } = run;
  void _gone;
  return rest as RichRun;
}

/** A change to a paragraph's attributes; `undefined` takes one off. */
type BlockPatch = { readonly [K in Exclude<keyof RichBlock, 'runs'>]?: RichBlock[K] | undefined };

function withBlock(block: RichBlock, patch: BlockPatch): RichBlock {
  const out: Record<string, unknown> = { ...block, ...patch };
  for (const [key, value] of Object.entries(out)) if (value === undefined || value === false || value === 0 || (key === 'kind' && value === 'p')) delete out[key];
  out.runs = block.runs;
  return out as unknown as RichBlock;
}

/** What a command does to a whole box: its new text, and any change to the box's own style. */
export interface WholeBox {
  readonly rich: RichText;
  readonly base?: Partial<RichBase>;
}

export function formatAll(rich: RichText, base: RichBase, command: FormatCommand): WholeBox {
  const runs = allRuns(rich).filter((r) => r.text !== '');
  switch (command.type) {
    case 'toggle': {
      const on = !(runs.length > 0 && runs.every((r) => r[command.mark] === true));
      return { rich: mapRuns(rich, (r) => (on ? { ...r, [command.mark]: true } : without(r, command.mark))) };
    }
    case 'script': {
      const on = !(runs.length > 0 && runs.every((r) => r.script === command.value));
      return { rich: mapRuns(rich, (r) => (on ? { ...r, script: command.value } : without(r, 'script'))) };
    }
    case 'highlight':
      return { rich: mapRuns(rich, (r) => (command.value ? { ...r, highlight: command.value } : without(r, 'highlight'))) };
    case 'color':
      return { rich: mapRuns(rich, (r) => without(r, 'color')), base: { color: command.value } };
    case 'font':
      return { rich: mapRuns(rich, (r) => without(r, 'font')), base: { fontFamily: command.value } };
    case 'size':
      return { rich: mapRuns(rich, (r) => without(r, 'size')), base: { fontSize: command.value } };
    case 'grow':
      return { rich: mapRuns(rich, (r) => without(r, 'size')), base: { fontSize: nextSize(base.fontSize, command.by) } };
    case 'clear':
      return { rich: mapRuns(rich, (r) => ({ text: r.text })) };
    case 'kind':
      return { rich: mapBlocks(rich, (b) => withBlock(b, { kind: command.value })) };
    case 'align':
      // The box's own alignment cannot be justified (it is a text box's, from before); every paragraph can.
      return command.value === 'justify'
        ? { rich: mapBlocks(rich, (b) => withBlock(b, { align: 'justify' })) }
        : { rich: mapBlocks(rich, (b) => withBlock(b, { align: undefined })), base: { align: command.value } };
    case 'list': {
      const on = !rich.blocks.every((b) => b.list === command.value);
      return { rich: mapBlocks(rich, (b) => withBlock(b, on ? { list: command.value } : { list: undefined, checked: undefined })) };
    }
    case 'indent':
      return { rich: mapBlocks(rich, (b) => withBlock(b, { indent: clampIndent((b.indent ?? 0) + command.by) })) };
  }
}

/** How a whole box is set, for the format bar when the box is selected but not being typed in. */
export function wholeBoxState(rich: RichText, base: RichBase): FormatState {
  const runs = allRuns(rich).filter((r) => r.text !== '');
  const all = (test: (r: RichRun) => boolean): boolean => runs.length > 0 && runs.every(test);
  const first = rich.blocks[0];
  const kind = first?.kind ?? 'p';
  const same = <T,>(values: readonly T[]): T | null => (values.length > 0 && values.every((v) => v === values[0]) ? values[0]! : null);
  return {
    bold: all((r) => r.bold === true),
    italic: all((r) => r.italic === true),
    underline: all((r) => r.underline === true),
    strike: all((r) => r.strike === true),
    script: same(runs.map((r) => r.script ?? null)),
    color: same(runs.map((r) => r.color ?? base.color)) ?? base.color,
    highlight: same(runs.map((r) => r.highlight ?? null)),
    size: same(runs.map((r) => r.size ?? base.fontSize * HEADING_SCALE[kind])) ?? base.fontSize,
    font: same(runs.map((r) => r.font ?? base.fontFamily)) ?? base.fontFamily,
    kind,
    list: same(rich.blocks.map((b) => b.list ?? null)),
    align: same(rich.blocks.map((b) => b.align ?? base.align)) ?? base.align,
    indent: first?.indent ?? 0,
  };
}
