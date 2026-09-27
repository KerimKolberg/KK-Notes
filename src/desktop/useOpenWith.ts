/**
 * An "open with" that arrives while the app is *already running*.
 *
 * This is the common case, not the exception, and it was the one that did
 * nothing. The activity is `launchMode="singleTask"`, so tapping a PDF in a
 * file manager while the app is in memory does not start it afresh — Android
 * brings the existing instance forward and delivers the intent to
 * `onNewIntent`. `MainActivity` then dispatches a `notex-open-with` event into
 * the page, which nothing listened for: the app came to the front showing
 * whatever it had been showing, and the file was silently dropped.
 *
 * The boot path ({@link resolveBootTarget}) only covers a cold start, because
 * it runs once and *consumes* the bridge. So the two halves are:
 *
 * | when | how it arrives | handled by |
 * | --- | --- | --- |
 * | app not running | the bridge, read at boot | `resolveBootTarget` |
 * | app already running | the `notex-open-with` event | this hook |
 */
import { useEffect } from 'react';
import { useRouteStore } from '../library/routeStore';
import { openDocumentInTab } from '../document/tabStore';
import { openRequested } from './boot';
import { onOpenWith, type OpenWithRequest } from './openWith';

/**
 * Open a document handed over by a running app's intent.
 *
 * Exported for the tests, which drive it without a React tree.
 */
export async function handleOpenWith(request: OpenWithRequest): Promise<void> {
  // Opened in its own tab, so there is nothing to discard and nothing to ask
  // about: the page already on screen stays open beside it. Before tabs this
  // needed a prompt, because arriving here meant replacing it.
  let path: string | null = null;
  const opened = await openDocumentInTab(async () => {
    const target = await openRequested(request);
    path = target?.path ?? null;
    return target !== null;
  });
  // `openRequested` has already raised a notice if it failed; going nowhere is
  // right in that case, because the document the user was looking at is still
  // the document they are looking at.
  if (opened) useRouteStore.getState().openDocument(path);
}

/** Listen for intents delivered to a running app. */
export function useOpenWith(): void {
  useEffect(() => onOpenWith((request) => void handleOpenWith(request)), []);
}
