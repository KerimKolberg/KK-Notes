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
import { openRequested } from './boot';
import { confirmDiscardIfDirty } from './fileActions';
import { onOpenWith, type OpenWithRequest } from './openWith';

/**
 * Open a document handed over by a running app's intent.
 *
 * Exported for the tests, which drive it without a React tree.
 */
export async function handleOpenWith(request: OpenWithRequest): Promise<void> {
  // Picking this app to open a file is explicit, but so is the unsaved page
  // already on screen. Replacing that without asking is the one thing here
  // that cannot be undone, so it is the one thing worth a prompt.
  if (!(await confirmDiscardIfDirty())) return;
  const target = await openRequested(request);
  // `openRequested` has already raised a notice if it failed; going nowhere is
  // right in that case, because the document the user was looking at is still
  // the document they are looking at.
  if (target) useRouteStore.getState().openDocument(target.path);
}

/** Listen for intents delivered to a running app. */
export function useOpenWith(): void {
  useEffect(() => onOpenWith((request) => void handleOpenWith(request)), []);
}
