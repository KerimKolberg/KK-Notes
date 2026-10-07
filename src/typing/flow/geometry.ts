/**
 * Where a page's own text goes: inside margins all round, as on a word processor's page. Two centimetres at the
 * app's 96 px to the inch — narrower than Word's inch, because a note's page (A4 at 794 px) is read on a tablet.
 */
import { createStrokeId } from '../../inking/engine/ids';
import { DEFAULT_TEXT_STYLE } from '../../document/media';
import { EMPTY_RICH } from '../../document/richText';
import type { Page, TextBox } from '../../document/types';

export const FLOW_MARGIN = 76;

/** A page's text box, empty, filling the page inside its margins. Behind anything else placed on the page. */
export function createFlowBox(page: Pick<Page, 'dimensions'>, zIndex: number): TextBox {
  const { width, height } = page.dimensions;
  const margin = Math.min(FLOW_MARGIN, width / 6, height / 6);
  return {
    kind: 'text',
    id: `text_${createStrokeId()}`,
    x: margin,
    y: margin,
    width: Math.max(1, width - 2 * margin),
    height: Math.max(1, height - 2 * margin),
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
