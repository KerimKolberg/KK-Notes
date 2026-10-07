import { describe, expect, it, vi } from 'vitest';

const OLD = 'C:\\Users\\k\\AppData\\Roaming\\com.notex.app\\library';
const NEW = 'C:\\Users\\k\\AppData\\Roaming\\KK-Notes\\library';

async function load(answer: unknown) {
  vi.resetModules();
  vi.doMock('../../desktop/tauri', () => ({ isTauri: () => true, tauriInvoke: async () => answer }));
  const { useNoteMetaStore } = await import('../noteMeta');
  const { followLibraryMove } = await import('../libraryMove');
  return { useNoteMetaStore, followLibraryMove };
}

describe('following the library to its renamed folder', () => {

  it('moves the favourites and tags of notes in the old library, and leaves others alone', async () => {
    const { useNoteMetaStore, followLibraryMove } = await load({ from: OLD, to: NEW });
    useNoteMetaStore.getState().toggleFavourite(`${OLD}\\Maths\\Algebra.notex`);
    useNoteMetaStore.getState().setTags('D:\\Essay.notex', ['school']);
    await followLibraryMove();
    const map = useNoteMetaStore.getState().map;
    expect(map[`${NEW}\\Maths\\Algebra.notex`]?.favourite).toBe(true);
    expect(map[`${OLD}\\Maths\\Algebra.notex`]).toBeUndefined();
    expect(map['D:\\Essay.notex']?.tags).toEqual(['school']);
  });

  it('changes nothing when nothing was moved', async () => {
    const { useNoteMetaStore, followLibraryMove } = await load(null);
    useNoteMetaStore.getState().toggleFavourite(`${OLD}\\A.notex`);
    const before = useNoteMetaStore.getState().map;
    await followLibraryMove();
    expect(useNoteMetaStore.getState().map).toBe(before);
  });
});
