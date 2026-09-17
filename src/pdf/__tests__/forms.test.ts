import { describe, expect, it } from 'vitest';
import type { PdfViewBox } from '../../document/types';
import {
  applyFieldInput,
  extractFormFields,
  fieldIsChecked,
  fieldText,
  initialFormValues,
  parsePageRanges,
  type PdfAnnotationData,
} from '../forms';

const LETTER: PdfViewBox = [0, 0, 612, 792];
const ctx = { viewBox: LETTER, rotation: 0, scale: 1 };

const annotations: PdfAnnotationData[] = [
  { subtype: 'Widget', id: '10R', fieldType: 'Tx', fieldName: 'fullName', fieldValue: 'Ada', rect: [72, 700, 372, 724], maxLen: 40, textAlignment: 1, defaultAppearanceData: { fontSize: 12 } },
  { subtype: 'Widget', id: '11R', fieldType: 'Tx', fieldName: 'notes', fieldValue: '', rect: [72, 600, 372, 680], multiLine: true },
  { subtype: 'Widget', id: '12R', fieldType: 'Btn', fieldName: 'agree', checkBox: true, exportValue: 'Yes', fieldValue: 'Yes', rect: [72, 560, 90, 578] },
  { subtype: 'Widget', id: '13R', fieldType: 'Btn', fieldName: 'size', radioButton: true, buttonValue: 'S', fieldValue: 'M', rect: [72, 520, 90, 538] },
  { subtype: 'Widget', id: '14R', fieldType: 'Btn', fieldName: 'size', radioButton: true, buttonValue: 'M', fieldValue: 'M', rect: [100, 520, 118, 538] },
  { subtype: 'Widget', id: '15R', fieldType: 'Ch', fieldName: 'colour', combo: true, fieldValue: ['blue'], rect: [72, 480, 200, 500], options: [{ exportValue: 'red', displayValue: 'Red' }, { exportValue: 'blue', displayValue: 'Blue' }] },
  { subtype: 'Widget', id: '16R', fieldType: 'Ch', fieldName: 'toppings', multiSelect: true, rect: [72, 400, 200, 460], options: [{ exportValue: 'a', displayValue: 'A' }] },
  { subtype: 'Widget', id: '17R', fieldType: 'Btn', fieldName: 'submit', pushButton: true, rect: [72, 300, 172, 330] },
  { subtype: 'Widget', id: '18R', fieldType: 'Tx', fieldName: 'secret', hidden: true, rect: [0, 0, 10, 10] },
  { subtype: 'Link', id: '19R', rect: [0, 0, 10, 10] },
  { subtype: 'Widget', id: '20R', fieldType: 'Sig', fieldName: 'sig', rect: [0, 0, 10, 10] },
];

describe('extractFormFields', () => {
  const fields = extractFormFields(annotations, ctx);

  it('keeps only renderable widgets and classifies them', () => {
    expect(fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      'fullName:text',
      'notes:textarea',
      'agree:checkbox',
      'size:radio',
      'size:radio',
      'colour:select',
      'toppings:listbox',
    ]);
  });

  it('projects rects into page-local boxes using the shared coordinate math', () => {
    const name = fields[0];
    expect(name?.box).toEqual({ x: 72, y: 792 - 724, width: 300, height: 24 });
    expect(name?.maxLength).toBe(40);
    expect(name?.textAlign).toBe('center');
    expect(name?.fontSize).toBe(12);
    const scaled = extractFormFields(annotations, { ...ctx, scale: 2 })[0];
    expect(scaled?.box).toEqual({ x: 144, y: 136, width: 600, height: 48 });
    expect(scaled?.fontSize).toBe(24);
  });

  it('carries export values, options and flags', () => {
    expect(fields[2]?.exportValue).toBe('Yes');
    expect(fields[3]?.exportValue).toBe('S');
    expect(fields[4]?.exportValue).toBe('M');
    expect(fields[5]?.options).toEqual([
      { label: 'Red', value: 'red' },
      { label: 'Blue', value: 'blue' },
    ]);
    expect(fields[6]?.multiSelect).toBe(true);
    expect(fields[6]?.readOnly).toBe(false);
  });

  it('falls back to a generated name for unnamed widgets', () => {
    const [f] = extractFormFields([{ subtype: 'Widget', id: '9R', fieldType: 'Tx', rect: [0, 0, 10, 10] }], ctx);
    expect(f?.name).toBe('field_9R');
  });
});

describe('initialFormValues / applyFieldInput', () => {
  const fields = extractFormFields(annotations, ctx);
  const values = initialFormValues(fields, annotations);

  it('seeds values from the PDF: strings, booleans and the radio group selection', () => {
    expect(values).toEqual({ fullName: 'Ada', notes: '', agree: true, size: 'M', colour: 'blue', toppings: '' });
  });

  it('checkbox input toggles a boolean', () => {
    const agree = fields[2];
    if (!agree) throw new Error('field');
    const off = applyFieldInput(values, agree, false);
    expect(off.agree).toBe(false);
    expect(applyFieldInput(off, agree, true).agree).toBe(true);
    expect(applyFieldInput(values, agree, true)).toBe(values); // unchanged → same object
  });

  it('radio input selects the widget export value for the whole group', () => {
    const small = fields[3];
    const medium = fields[4];
    if (!small || !medium) throw new Error('field');
    const picked = applyFieldInput(values, small, true);
    expect(picked.size).toBe('S');
    expect(fieldIsChecked(small, picked)).toBe(true);
    expect(fieldIsChecked(medium, picked)).toBe(false);
    expect(applyFieldInput(picked, small, false)).toBe(picked); // cannot deselect
  });

  it('text input is stored as a string and clipped to maxLength', () => {
    const name = fields[0];
    if (!name) throw new Error('field');
    const next = applyFieldInput(values, name, 'x'.repeat(60));
    expect(fieldText(name, next)).toHaveLength(40);
    expect(values.fullName).toBe('Ada'); // immutable
  });

  it('select input stores the option value', () => {
    const colour = fields[5];
    if (!colour) throw new Error('field');
    expect(applyFieldInput(values, colour, 'red').colour).toBe('red');
  });
});

describe('parsePageRanges', () => {
  it('parses lists, ranges and open ends into 0-based indices', () => {
    expect(parsePageRanges('1-3, 5', 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRanges('8-', 10)).toEqual([7, 8, 9]);
    expect(parsePageRanges('-2', 10)).toEqual([0, 1]);
    expect(parsePageRanges('0, 12, x', 10)).toEqual([]);
    expect(parsePageRanges('3 3 2', 10)).toEqual([1, 2]);
  });
});
