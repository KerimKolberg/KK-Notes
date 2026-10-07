import { describe, expect, it } from 'vitest';
import type { RichText } from '../../../document/types';
import { fromDoc, toDoc } from '../convert';

describe('rich text and the editor', () => {
  it('goes into the editor and back unchanged', () => {
    const rich: RichText = {
      blocks: [
        { kind: 'h1', align: 'center', runs: [{ text: 'Title', color: '#ff0000' }] },
        { runs: [{ text: 'a ' }, { text: 'bold', bold: true, italic: true }, { text: ' x' }, { text: '2', script: 'sup', size: 24 }] },
        { list: 'number', indent: 1, runs: [{ text: 'one\ntwo', underline: true }] },
        { list: 'check', checked: true, runs: [{ text: 'done', highlight: '#fde68a', font: 'serif', strike: true }] },
        { cont: true, runs: [] },
      ],
    };
    expect(fromDoc(toDoc(rich))).toEqual(rich);
  });

  it('turns a line break into the editor\'s own, between two runs of text', () => {
    const doc = toDoc({ blocks: [{ runs: [{ text: 'a\nb' }] }] });
    const types: string[] = [];
    doc.firstChild!.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(['text', 'hard_break', 'text']);
  });

  it('gives an empty text a paragraph to type in', () => {
    expect(toDoc({ blocks: [] }).childCount).toBe(1);
  });
});
