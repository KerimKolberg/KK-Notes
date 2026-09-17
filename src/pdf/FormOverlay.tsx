import { memo, useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { ToolType } from '../inking/types';
import { useDocumentStore } from '../document/store';
import type { FormField, FormValues, Page } from '../document/types';
import { applyFieldInput, fieldIsChecked, fieldText } from './forms';

export interface FormOverlayProps {
  page: Page;
  zoom: number;
  tool: ToolType;
  /** Lock mode: form widgets stay usable, but the pen no longer draws over them. */
  readOnly?: boolean;
}

const BASE_WIDGET: CSSProperties = {
  position: 'absolute',
  boxSizing: 'border-box',
  margin: 0,
  pointerEvents: 'auto',
  fontFamily: 'Helvetica, Arial, sans-serif',
  color: '#111827',
  background: 'rgba(59, 130, 246, 0.08)',
  border: '1px solid rgba(59, 130, 246, 0.35)',
  borderRadius: 2,
  outlineOffset: 1,
};

function widgetStyle(field: FormField): CSSProperties {
  const { box } = field;
  const style: CSSProperties = { ...BASE_WIDGET, left: box.x, top: box.y, width: box.width, height: box.height };
  if (field.kind === 'text' || field.kind === 'textarea' || field.kind === 'select' || field.kind === 'listbox') {
    style.fontSize = field.fontSize ?? Math.max(8, Math.min(box.height * 0.62, 18));
    style.padding = field.kind === 'textarea' ? '2px 3px' : '0 3px';
    if (field.textAlign) style.textAlign = field.textAlign;
  }
  if (field.kind === 'checkbox' || field.kind === 'radio') {
    const size = Math.max(10, Math.min(box.width, box.height));
    style.width = size;
    style.height = size;
    style.left = box.x + (box.width - size) / 2;
    style.top = box.y + (box.height - size) / 2;
    style.background = 'transparent';
    style.border = 'none';
    style.accentColor = '#2563eb';
  }
  return style;
}

interface WidgetProps {
  pageId: string;
  field: FormField;
  values: FormValues;
  onInput: (field: FormField, input: string | boolean) => void;
}

const FormWidget = memo(function FormWidget({ pageId, field, values, onInput }: WidgetProps) {
  const common = {
    style: widgetStyle(field),
    disabled: field.readOnly,
    'aria-label': field.name,
    'data-form-field': field.name,
    'data-form-kind': field.kind,
    title: field.name,
  } as const;
  switch (field.kind) {
    case 'text':
      return (
        <input
          {...common}
          type="text"
          value={fieldText(field, values)}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          onChange={(e) => onInput(field, e.target.value)}
        />
      );
    case 'textarea':
      return (
        <textarea
          {...common}
          style={{ ...common.style, resize: 'none' }}
          value={fieldText(field, values)}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          onChange={(e) => onInput(field, e.target.value)}
        />
      );
    case 'checkbox':
      return (
        <input {...common} type="checkbox" checked={fieldIsChecked(field, values)} onChange={(e) => onInput(field, e.target.checked)} />
      );
    case 'radio':
      return (
        <input
          {...common}
          type="radio"
          name={`${pageId}:${field.name}`}
          value={field.exportValue ?? 'On'}
          checked={fieldIsChecked(field, values)}
          onChange={(e) => onInput(field, e.target.checked)}
        />
      );
    case 'select':
    case 'listbox': {
      const options = field.options ?? [];
      const rows = field.kind === 'listbox' ? Math.max(2, Math.min(options.length, Math.floor(field.box.height / 16))) : undefined;
      return (
        <select
          {...common}
          value={fieldText(field, values)}
          {...(rows !== undefined ? { size: rows } : {})}
          onChange={(e) => onInput(field, e.target.value)}
        >
          {field.kind === 'select' && <option value="">—</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
  }
});

/**
 * z-30 interactive AcroForm layer. Widgets are laid out in page units inside
 * a container scaled by the zoom. With a drawing tool active, a stylus
 * touching a widget is forwarded to the ink canvas so the pen can draw over
 * the whole page, while mouse and touch keep operating the controls. The
 * layer stays live in read-only mode: filling in a form is not an edit to
 * the document's ink.
 */
export const FormOverlay = memo(function FormOverlay({ page, zoom, tool, readOnly = false }: FormOverlayProps) {
  const setFormValue = useDocumentStore((s) => s.setFormValue);

  const onInput = useCallback(
    (field: FormField, input: string | boolean) => {
      const next = applyFieldInput(page.formValues, field, input);
      if (next === page.formValues) return;
      const value = next[field.name];
      if (value !== undefined) setFormValue(page.id, field.name, value);
    },
    [page.formValues, page.id, setFormValue],
  );

  const forwardPen = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Locked: nothing draws, so the pen operates the widget like a mouse.
      if (readOnly || tool === 'select' || e.pointerType !== 'pen') return;
      const live = e.currentTarget.parentElement?.parentElement?.querySelector<HTMLCanvasElement>('canvas[data-layer="live"]');
      if (!live) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target instanceof HTMLElement) e.target.blur();
      // The forwarded event captures the (real, active) pointer on the canvas,
      // so the rest of the stroke flows straight to the ink pipeline.
      live.dispatchEvent(new PointerEvent('pointerdown', e.nativeEvent));
    },
    [tool, readOnly],
  );

  if (page.formFields.length === 0) return null;
  return (
    <div className="absolute inset-0 z-30" style={{ pointerEvents: 'none' }} data-form-overlay>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: page.dimensions.width,
          height: page.dimensions.height,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
        onPointerDownCapture={forwardPen}
      >
        {page.formFields.map((field) => (
          <FormWidget key={field.id} pageId={page.id} field={field} values={page.formValues} onInput={onInput} />
        ))}
      </div>
    </div>
  );
});
