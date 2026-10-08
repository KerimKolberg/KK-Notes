import { describe, expect, it, vi } from 'vitest';

/** The strokes, as one call each: what matters here is when they are drawn, not how. */
vi.mock('../../../inking/engine/renderer', () => ({
  drawStroke: (ctx: { log: string[] }) => ctx.log.push('ink'),
}));

import { createDocument } from '../../operations';
import { createTextBox } from '../../media';
import type { Stroke } from '../../../inking/types';
import type { PageVisual, TextBox } from '../../types';
import { paintPage } from '../rasterize';

/** A canvas that writes down what it is asked to draw: every word, every stroke. */
function recorder(): { ctx: never; log: string[] } {
  const log: string[] = [];
  const state: Record<string | symbol, unknown> = { log };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 });
      if (prop === 'fillText') return (text: string) => log.push(`text:${text}`);
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as never, log };
}

function pageWith(box: TextBox): PageVisual {
  const page = createDocument(1).pages[0]!;
  return { ...page, template: 'blank', media: [box], strokes: [{ id: 's1' } as unknown as Stroke] };
}

describe('a page painted for a snapshot or a thumbnail', () => {
  const box: TextBox = { ...createTextBox({ width: 800, height: 1100 }, 1), text: 'Words', width: 400 };

  it('draws typed text behind the drawings before the ink', async () => {
    const { ctx, log } = recorder();
    await paintPage(ctx, pageWith(box), 1);
    expect(log.indexOf('text:Words')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('text:Words')).toBeLessThan(log.indexOf('ink'));
  });

  it('and typed text in front of them after it, over the ink, as the page shows it', async () => {
    const { ctx, log } = recorder();
    await paintPage(ctx, pageWith({ ...box, aboveInk: true }), 1);
    expect(log.indexOf('text:Words')).toBeGreaterThan(log.indexOf('ink'));
  });
});
