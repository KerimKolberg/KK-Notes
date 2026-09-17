/**
 * AcroForm widget extraction (from PDF.js annotation data) and value
 * synchronisation. Pure: no PDF.js import, so it runs in unit tests.
 */
import type { FormField, FormFieldKind, FormFieldOption, FormValue, FormValues, PdfViewBox } from '../document/types';
import { pdfRectToPageBoxScaled } from './pdfCoords';

/** The subset of PDF.js `getAnnotations()` output we read. */
export interface PdfAnnotationData {
  readonly subtype?: string;
  readonly id?: string;
  readonly rect?: readonly number[];
  readonly fieldType?: string | null;
  readonly fieldName?: string | null;
  readonly fieldValue?: unknown;
  readonly defaultFieldValue?: unknown;
  readonly readOnly?: boolean;
  readonly hidden?: boolean;
  readonly noView?: boolean;
  readonly checkBox?: boolean;
  readonly radioButton?: boolean;
  readonly pushButton?: boolean;
  readonly multiLine?: boolean;
  readonly comb?: boolean;
  readonly maxLen?: number | null;
  readonly combo?: boolean;
  readonly multiSelect?: boolean;
  readonly options?: ReadonlyArray<{ readonly exportValue?: string; readonly displayValue?: string }>;
  /** Checkbox: the on-state name. */
  readonly exportValue?: string | null;
  /** Radio: this widget's on-state name. */
  readonly buttonValue?: string | null;
  /** 0 left, 1 centre, 2 right. */
  readonly textAlignment?: number | null;
  readonly defaultAppearanceData?: { readonly fontSize?: number } | null;
}

export interface ExtractionContext {
  readonly viewBox: PdfViewBox;
  readonly rotation: number;
  /** Page px per PDF point. */
  readonly scale: number;
}

function kindOf(a: PdfAnnotationData): FormFieldKind | null {
  switch (a.fieldType) {
    case 'Tx':
      return a.multiLine ? 'textarea' : 'text';
    case 'Btn':
      if (a.pushButton) return null;
      if (a.radioButton) return 'radio';
      return 'checkbox';
    case 'Ch':
      return a.combo ? 'select' : 'listbox';
    default:
      return null;
  }
}

function optionsOf(a: PdfAnnotationData): FormFieldOption[] {
  return (a.options ?? []).map((o) => {
    const value = o.exportValue ?? o.displayValue ?? '';
    return { label: o.displayValue ?? value, value };
  });
}

/** Widgets we can render as HTML controls, in page-local coordinates. */
export function extractFormFields(annotations: readonly PdfAnnotationData[], ctx: ExtractionContext): FormField[] {
  const fields: FormField[] = [];
  annotations.forEach((a, i) => {
    if (a.subtype !== 'Widget' || a.hidden || a.noView) return;
    const kind = kindOf(a);
    if (!kind || !a.rect || a.rect.length < 4) return;
    const name = a.fieldName && a.fieldName.length > 0 ? a.fieldName : `field_${a.id ?? i}`;
    const box = pdfRectToPageBoxScaled(a.rect, ctx.viewBox, ctx.rotation, ctx.scale);
    const fontSizePt = a.defaultAppearanceData?.fontSize;
    const field: FormField = {
      id: a.id ?? `${name}#${i}`,
      name,
      kind,
      box,
      readOnly: Boolean(a.readOnly),
      ...(kind === 'select' || kind === 'listbox' ? { options: optionsOf(a) } : {}),
      ...(kind === 'checkbox' ? { exportValue: a.exportValue ?? 'Yes' } : {}),
      ...(kind === 'radio' ? { exportValue: a.buttonValue ?? a.exportValue ?? 'On' } : {}),
      ...(typeof a.maxLen === 'number' && a.maxLen > 0 ? { maxLength: a.maxLen } : {}),
      ...(fontSizePt && fontSizePt > 0 ? { fontSize: fontSizePt * ctx.scale } : {}),
      ...(a.textAlignment === 1 ? { textAlign: 'center' as const } : a.textAlignment === 2 ? { textAlign: 'right' as const } : {}),
      ...(kind === 'listbox' && a.multiSelect ? { multiSelect: true } : {}),
    };
    fields.push(field);
  });
  return fields;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * Initial `formValues` from the annotations' current values. Checkboxes
 * become booleans; radio groups store the selected export value under the
 * shared group name; everything else is a string.
 */
export function initialFormValues(fields: readonly FormField[], annotations: readonly PdfAnnotationData[]): FormValues {
  const byId = new Map<string, PdfAnnotationData>();
  annotations.forEach((a, i) => byId.set(a.id ?? `${a.fieldName ?? 'field'}#${i}`, a));
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    const a = byId.get(field.id);
    const raw = a?.fieldValue ?? a?.defaultFieldValue;
    switch (field.kind) {
      case 'checkbox': {
        const v = asString(raw);
        values[field.name] = v !== '' && v !== 'Off' && (field.exportValue === undefined || v === field.exportValue);
        break;
      }
      case 'radio': {
        const v = asString(raw);
        if (v !== '' && v !== 'Off') values[field.name] = v;
        else if (!(field.name in values)) values[field.name] = '';
        break;
      }
      default:
        if (!(field.name in values)) values[field.name] = asString(raw);
    }
  }
  return values;
}

/** New values after the user changes one control. */
export function applyFieldInput(values: FormValues, field: FormField, input: string | boolean): FormValues {
  let next: FormValue;
  switch (field.kind) {
    case 'checkbox':
      next = input === true || input === field.exportValue;
      break;
    case 'radio':
      // Selecting a radio sets the group's export value; deselecting is not a thing.
      if (input === false) return values;
      next = field.exportValue ?? 'On';
      break;
    default:
      next = typeof input === 'boolean' ? String(input) : input;
      if (field.maxLength !== undefined && next.length > field.maxLength) next = next.slice(0, field.maxLength);
  }
  if (values[field.name] === next) return values;
  return { ...values, [field.name]: next };
}

export function fieldIsChecked(field: FormField, values: FormValues): boolean {
  const v = values[field.name];
  if (field.kind === 'checkbox') return v === true;
  if (field.kind === 'radio') return typeof v === 'string' && v !== '' && v === field.exportValue;
  return false;
}

export function fieldText(field: FormField, values: FormValues): string {
  const v = values[field.name];
  return typeof v === 'string' ? v : '';
}

/** Parse "1-3, 5, 8-" style ranges into 0-based page indices. */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const out = new Set<number>();
  for (const part of input.split(/[,\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)?(?:-(\d+)?)?$/);
    if (!m) continue;
    const start = m[1] ? Number(m[1]) : 1;
    const end = part.includes('-') ? (m[2] ? Number(m[2]) : pageCount) : start;
    for (let n = Math.max(1, start); n <= Math.min(pageCount, end); n++) out.add(n - 1);
  }
  return [...out].sort((a, b) => a - b);
}
