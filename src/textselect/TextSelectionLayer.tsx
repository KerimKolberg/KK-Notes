import { memo } from 'react';
import { spanPolygon } from './geometry';
import { useTextSelectStore, type TextSurface } from './textSelectStore';

/**
 * The selected text on one page, shaded. Drawn in the page's own units and stretched over the page, so it stays on
 * the words at any zoom; and it takes no pointer events, so it is never in the way of anything.
 */
export const TextSelectionLayer = memo(function TextSelectionLayer({ surface, pageId }: { readonly surface: TextSurface; readonly pageId: string }) {
  const selection = useTextSelectStore((s) => (s.selection?.surface === surface && s.selection.pageId === pageId ? s.selection : null));
  if (!selection) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[36] h-full w-full"
      viewBox={`0 0 ${selection.pageWidth} ${selection.pageHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-text-selection={selection.lines.length}
      style={{ mixBlendMode: 'multiply' }}
    >
      {selection.lines.map((line, i) => (
        <polygon key={i} points={spanPolygon(line).map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(37, 99, 235, 0.32)" />
      ))}
    </svg>
  );
});
