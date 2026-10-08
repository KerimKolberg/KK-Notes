/**
 * Where a page's own text goes: inside margins all round, as on a word processor's page (`pageTextFrame`).
 */
import { createStrokeId } from '../../inking/engine/ids';
import { DEFAULT_TEXT_STYLE, pageTextFrame } from '../../document/media';
import { EMPTY_RICH } from '../../document/richText';
import type { Page, TextBox } from '../../document/types';

/** A page's text box, empty, filling the page inside its margins. Behind anything else placed on the page. */
export function createFlowBox(page: Pick<Page, 'dimensions'>, zIndex: number): TextBox {
  return {
    kind: 'text',
    id: `text_${createStrokeId()}`,
    ...pageTextFrame(page.dimensions),
    rotation: 0,
    zIndex,
    ...DEFAULT_TEXT_STYLE,
    text: '',
    rich: EMPTY_RICH,
    flow: true,
  };
}

/** The lowest place in a page's stack: page text sits under every picture, note and table placed on it. */
export function bottomZIndex(page: Page): number {
  return page.media.reduce((low, m) => Math.min(low, m.zIndex), 1) - 1;
}
