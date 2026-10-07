/**
 * The editor is in a chunk of its own (ProseMirror is most of it), loaded the first time a note shows a text box.
 * Until it is there a box shows its text as it would look (`richDom.ts`), so nothing jumps when it arrives.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

type EditorModule = typeof import('./editor/RichEditor');

const useLoaded = create<{ module: EditorModule | null }>(() => ({ module: null }));
let pending: Promise<EditorModule> | null = null;

export function loadEditor(): Promise<EditorModule> {
  pending ??= import('./editor/RichEditor').then((module) => {
    useLoaded.setState({ module });
    return module;
  });
  return pending;
}

/** The editor, once it is loaded; asking starts the loading. */
export function useEditorModule(): EditorModule | null {
  const module = useLoaded((s) => s.module);
  useEffect(() => {
    if (!module) void loadEditor().catch(() => {});
  }, [module]);
  return module;
}
