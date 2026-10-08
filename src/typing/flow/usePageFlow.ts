import { useMemo } from 'react';
import type { EditorEdges } from '../editor/RichEditor';
import { backspaceAtStart, deleteAtEnd, leave, pageBreakAt, scheduleFlow, trimEnd } from './engine';

export interface PageFlowProps {
  readonly edges?: EditorEdges;
  readonly onEdited?: (mediaId: string) => void;
}

/** What page text on a page needs to continue on the pages around it (`engine.ts`). */
export function usePageFlow(pageId: string): PageFlowProps {
  return useMemo(
    () => ({
      onEdited: () => scheduleFlow(pageId),
      edges: {
        backspaceAtStart: () => backspaceAtStart(pageId),
        deleteAtEnd: () => deleteAtEnd(pageId),
        leave: (direction, how) => leave(pageId, direction, how),
        pageBreak: (pos) => pageBreakAt(pageId, pos),
        trimEnd: () => trimEnd(pageId),
      },
    }),
    [pageId],
  );
}
