/**
 * A box's rich text and the editor's document, each into the other. Lossless both ways for anything the model
 * can hold: a run's marks become the editor's marks, a `\n` in a run a line break, a paragraph's attributes its
 * own.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { normalizeRuns } from '../../document/richText';
import type { RichBlock, RichMarks, RichRun, RichText } from '../../document/types';
import { DEFAULT_BLOCK, lookOf, schema, type BlockAttrs } from './schema';

export function blockAttrsOf(block: RichBlock): BlockAttrs {
  return {
    kind: block.kind ?? 'p',
    list: block.list ?? null,
    indent: block.indent ?? 0,
    checked: block.checked === true,
    align: block.align ?? null,
    cont: block.cont === true,
    pageBreak: block.pageBreak === true,
  };
}

export function marksFor(run: RichMarks): Mark[] {
  const marks: Mark[] = [];
  if (run.font) marks.push(schema.marks.font!.create({ value: run.font }));
  if (run.size) marks.push(schema.marks.size!.create({ value: run.size }));
  if (run.color) marks.push(schema.marks.color!.create({ value: run.color }));
  if (run.highlight) marks.push(schema.marks.highlight!.create({ value: run.highlight }));
  if (run.bold) marks.push(schema.marks.bold!.create());
  if (run.italic) marks.push(schema.marks.italic!.create());
  if (run.underline) marks.push(schema.marks.underline!.create());
  if (run.strike) marks.push(schema.marks.strike!.create());
  if (run.script) marks.push(schema.marks.script!.create({ value: run.script }));
  return marks;
}

export function runMarksOf(marks: readonly Mark[]): RichMarks {
  const out: Record<string, unknown> = {};
  for (const mark of marks) {
    const name = mark.type.name;
    if (name === 'bold' || name === 'italic' || name === 'underline' || name === 'strike') out[name] = true;
    else out[name] = mark.attrs.value;
  }
  return out as RichMarks;
}

function inline(runs: readonly RichRun[]): PMNode[] {
  const nodes: PMNode[] = [];
  for (const run of runs) {
    const marks = marksFor(run);
    run.text.split('\n').forEach((part, i) => {
      if (i > 0) nodes.push(schema.nodes.hard_break!.create(null, null, marks));
      if (part !== '') nodes.push(schema.text(part, marks));
    });
  }
  return nodes;
}

export function blockNode(block: RichBlock): PMNode {
  return schema.nodes.paragraph!.create(blockAttrsOf(block), inline(block.runs));
}

export function toDoc(rich: RichText): PMNode {
  const blocks = rich.blocks.length > 0 ? rich.blocks : [{ runs: [] }];
  return schema.nodes.doc!.create(null, blocks.map(blockNode));
}

export function blockOf(node: PMNode): RichBlock {
  const runs: RichRun[] = [];
  node.forEach((child) => {
    if (child.isText) runs.push({ ...runMarksOf(child.marks), text: child.text ?? '' });
    else if (child.type === schema.nodes.hard_break) runs.push({ ...runMarksOf(child.marks), text: '\n' });
  });
  return { ...lookOf(node.attrs), runs: normalizeRuns(runs) };
}

export function fromDoc(doc: PMNode): RichText {
  const blocks: RichBlock[] = [];
  doc.forEach((node) => blocks.push(blockOf(node)));
  return { blocks };
}

export { DEFAULT_BLOCK };
