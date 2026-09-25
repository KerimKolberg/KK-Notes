/**
 * What the last GoodNotes import did, held until the user has read it.
 *
 * Separate from a top-bar notice because the notice is the wrong surface for
 * this: it truncates to one line, and on a phone it is not rendered at all.
 * An import from a format nobody documents cannot report itself in a place the
 * user may never see — "eleven of your fourteen pages came in, as pen" has to
 * arrive, or the feature quietly lies about what it did.
 *
 * Types only from `./import`, which erases at build time, so the store stays off
 * the importer's dependencies and out of the critical path.
 */
import { create } from 'zustand';
import type { ArchiveEntrySummary, ImportReport } from './import';

export type ImportOutcome =
  | { readonly kind: 'imported'; readonly report: ImportReport }
  | {
      readonly kind: 'failed';
      readonly fileName: string;
      readonly message: string;
      /** What the archive held, so a failure can still say what is in the file. */
      readonly entries: readonly ArchiveEntrySummary[];
    };

interface ImportReportStore {
  outcome: ImportOutcome | null;
  setOutcome: (outcome: ImportOutcome | null) => void;
}

export const useImportReportStore = create<ImportReportStore>()((set) => ({
  outcome: null,
  setOutcome: (outcome) => set({ outcome }),
}));
