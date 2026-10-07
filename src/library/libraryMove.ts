import { isTauri, tauriInvoke } from '../desktop/tauri';
import { useNoteMetaStore } from './noteMeta';

interface LibraryMove {
  readonly from: string;
  readonly to: string;
}

/**
 * The favourites and tags follow the library when the app's data folder was renamed (`src-tauri/src/data_dir.rs`:
 * on Windows, from `com.notex.app` to `KK-Notes`). They are kept here by each note's path, which the shell cannot
 * reach, so it says where the library was and is. Asked on every start: once nothing is left under the old folder
 * it changes nothing.
 */
export async function followLibraryMove(): Promise<void> {
  if (!isTauri()) return;
  try {
    const moved = await tauriInvoke<LibraryMove | null>('library_moved');
    if (moved && moved.from !== moved.to) useNoteMetaStore.getState().moved(moved.from, moved.to);
  } catch {
    // An older shell: nothing was moved.
  }
}
