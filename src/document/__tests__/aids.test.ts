import { beforeEach, describe, expect, it } from 'vitest';
import { useAidStore } from '../aids';

const store = useAidStore;
const page = { id: 'p1', dimensions: { width: 794, height: 1123 } };
const other = { id: 'p2', dimensions: { width: 600, height: 800 } };

describe('the drawing aids', () => {
  beforeEach(() => {
    store.getState().closeRuler();
    store.getState().closeProtractor();
  });

  it('start put away', () => {
    expect(store.getState().ruler).toBeNull();
    expect(store.getState().protractor).toBeNull();
  });

  describe('the ruler', () => {
    it('comes out on a page, in the middle of it', () => {
      store.getState().toggleRuler(page);
      const r = store.getState().ruler!;
      expect(r.pageId).toBe('p1');
      expect(r.x).toBeCloseTo(397);
      expect(r.angle).toBe(0);
    });

    it('goes away when toggled again on the same page', () => {
      store.getState().toggleRuler(page);
      store.getState().toggleRuler(page);
      expect(store.getState().ruler).toBeNull();
    });

    it('moves to another page rather than staying on the first, when called there', () => {
      store.getState().toggleRuler(page);
      store.getState().toggleRuler(other);
      expect(store.getState().ruler?.pageId).toBe('p2');
      expect(store.getState().ruler!.x).toBeCloseTo(300);
    });

    it('can be moved and turned, and stays on its page', () => {
      store.getState().toggleRuler(page);
      store.getState().setRuler({ x: 100, y: 200, angle: 1 }, page.dimensions);
      expect(store.getState().ruler).toMatchObject({ x: 100, y: 200, angle: 1, pageId: 'p1' });
      store.getState().setRuler({ x: -900, y: 5000 }, page.dimensions);
      expect(store.getState().ruler).toMatchObject({ x: 0, y: 1123 });
    });

    it('ignores a move when it is not out', () => {
      store.getState().setRuler({ x: 5 }, page.dimensions);
      expect(store.getState().ruler).toBeNull();
    });

    it('can be put away from wherever', () => {
      store.getState().toggleRuler(page);
      store.getState().closeRuler();
      expect(store.getState().ruler).toBeNull();
    });
  });

  describe('the protractor', () => {
    it('comes out, moves and turns, and is put away, on its own', () => {
      store.getState().toggleProtractor(page);
      expect(store.getState().protractor?.pageId).toBe('p1');
      store.getState().setProtractor({ x: 50, y: 60, angle: -0.5 }, page.dimensions);
      expect(store.getState().protractor).toMatchObject({ x: 50, y: 60, angle: -0.5 });
      store.getState().toggleProtractor(page);
      expect(store.getState().protractor).toBeNull();
    });

    it('is independent of the ruler', () => {
      store.getState().toggleRuler(page);
      store.getState().toggleProtractor(page);
      store.getState().closeRuler();
      expect(store.getState().protractor).not.toBeNull();
      expect(store.getState().ruler).toBeNull();
    });
  });
});
