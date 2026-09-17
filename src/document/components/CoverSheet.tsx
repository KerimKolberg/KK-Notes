import { memo } from 'react';
import type { PageLayout } from '../layout';
import type { Cover } from '../types';

export interface CoverSheetProps {
  cover: Cover;
  layout: PageLayout;
  /** Page count printed under the description. */
  pageCount: number;
}

/**
 * Notebook cover: the first sheet in the viewer, before page 1. It is not a
 * page — nothing can be drawn on it and it never takes part in numbering,
 * virtualisation or export.
 */
export const CoverSheet = memo(function CoverSheet({ cover, layout, pageCount }: CoverSheetProps) {
  const scale = layout.width / 794;
  return (
    <article
      className="absolute overflow-hidden rounded-sm shadow-xl ring-1 ring-black/15 dark:ring-white/10"
      style={{
        top: layout.top,
        left: layout.left,
        width: layout.width,
        height: layout.height,
        backgroundColor: cover.coverColor,
        color: cover.textColor,
      }}
      data-cover
      aria-label={`Notebook cover: ${cover.title || 'Untitled'}`}
    >
      {/* Spine and a hairline border, so the sheet reads as a cover board. */}
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: 26 * scale, background: 'rgba(0, 0, 0, 0.16)' }}
        aria-hidden="true"
      />
      <div
        className="absolute"
        style={{
          inset: `${34 * scale}px ${44 * scale}px ${34 * scale}px ${64 * scale}px`,
          border: `${Math.max(1, 1.5 * scale)}px solid currentColor`,
          opacity: 0.35,
          borderRadius: 4 * scale,
        }}
        aria-hidden="true"
      />
      <div
        className="absolute flex flex-col justify-center"
        style={{ inset: `${34 * scale}px ${72 * scale}px ${34 * scale}px ${92 * scale}px`, gap: 16 * scale }}
      >
        <h1
          className="font-semibold leading-tight"
          style={{ fontSize: 44 * scale, letterSpacing: -0.5 * scale }}
          data-cover-title
        >
          {cover.title}
        </h1>
        {cover.description && (
          <p className="leading-snug opacity-80" style={{ fontSize: 19 * scale }} data-cover-description>
            {cover.description}
          </p>
        )}
        <p className="opacity-60" style={{ fontSize: 15 * scale }}>
          {pageCount} {pageCount === 1 ? 'page' : 'pages'}
        </p>
      </div>
    </article>
  );
});
