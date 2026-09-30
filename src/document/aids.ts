/**
 * The drawing aids on a page: a ruler to draw along and a protractor to read angles
 * from. They are furniture, not content: nothing here is saved with the note, exported
 * or undone, and each lives on one page until it is put away or called to another.
 */
import { create } from 'zustand';
import { initialRuler, keepOnPage, type Ruler } from '../inking/engine/ruler';
import { initialProtractor, keepProtractorOnPage, type Protractor } from '../inking/engine/protractor';

interface PageSize {
  readonly id: string;
  readonly dimensions: { readonly width: number; readonly height: number };
}

export interface RulerAid extends Ruler {
  readonly pageId: string;
}

export interface ProtractorAid extends Protractor {
  readonly pageId: string;
}

interface AidStore {
  readonly ruler: RulerAid | null;
  readonly protractor: ProtractorAid | null;
  /** Put the ruler on this page, or put it away if it is already there. */
  toggleRuler: (page: PageSize) => void;
  /** Move or turn the ruler. Ignored when it is not out. */
  setRuler: (patch: Partial<Ruler>, page: PageSize['dimensions']) => void;
  closeRuler: () => void;
  toggleProtractor: (page: PageSize) => void;
  setProtractor: (patch: Partial<Protractor>, page: PageSize['dimensions']) => void;
  closeProtractor: () => void;
}

export const useAidStore = create<AidStore>()((set) => ({
  ruler: null,
  protractor: null,

  toggleRuler: (page) =>
    set((s) =>
      s.ruler?.pageId === page.id ? { ruler: null } : { ruler: { ...initialRuler(page.dimensions), pageId: page.id } },
    ),
  setRuler: (patch, dimensions) =>
    set((s) => (s.ruler ? { ruler: { ...keepOnPage({ ...s.ruler, ...patch }, dimensions), pageId: s.ruler.pageId } } : s)),
  closeRuler: () => set((s) => (s.ruler ? { ruler: null } : s)),

  toggleProtractor: (page) =>
    set((s) =>
      s.protractor?.pageId === page.id
        ? { protractor: null }
        : { protractor: { ...initialProtractor(page.dimensions), pageId: page.id } },
    ),
  setProtractor: (patch, dimensions) =>
    set((s) =>
      s.protractor
        ? { protractor: { ...keepProtractorOnPage({ ...s.protractor, ...patch }, dimensions), pageId: s.protractor.pageId } }
        : s,
    ),
  closeProtractor: () => set((s) => (s.protractor ? { protractor: null } : s)),
}));
