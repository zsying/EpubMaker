// Dropping an EPUB on the window is the shortest import path there is, but a
// webview cannot do it on its own: the HTML5 drop event hands the page File
// objects with no filesystem path, and this app reads books straight from disk.
// Only the native side can turn a drop into paths.
//
// That is `EnableFileDrop` on the window in app/main.go, plus a Go listener on
// events.Common.WindowFilesDropped that re-emits the paths as the host event
// "epub:dropped". This module subscribes to it and fans them out.
//
// A drop anywhere in the window counts: the shelf holds one small box, but a
// file dropped anywhere on it should import.
import { isDesktopHost, onHostEvent } from './api';
import { toast } from './toast';

type DropListener = (paths: string[]) => void;

const listeners = new Set<DropListener>();
let subscribing = false;
let subscribed = false;

/**
 * True when a drop can be turned into filesystem paths. Only the desktop host
 * has one — the phone imports through the share sheet instead, and its shelf
 * hides the drop affordance.
 */
export function canResolveDropPaths(): boolean {
  return isDesktopHost();
}

/** Registers the bridge once. Safe to call repeatedly. */
function ensureSubscribed(): void {
  if (subscribed || subscribing) return;
  subscribing = true;
  void onHostEvent('epub:dropped', (payload: unknown) => {
    const paths = Array.isArray(payload) ? (payload as string[]) : [];
    if (!paths.length) return;
    if (listeners.size === 0) {
      // Only the shelf imports, and saying so beats a drop that does nothing.
      toast('把 .epub 文件拖到书架才能导入', 'info');
      return;
    }
    for (const fn of [...listeners]) fn(paths);
  })
    .then(() => {
      subscribed = true;
    })
    .finally(() => {
      subscribing = false;
    });
}

/**
 * Registers the drop bridge up front, before any page subscribes.
 *
 * Called from App so a drop that lands on a page without a drop target still
 * says why nothing happened, instead of vanishing.
 */
export function initFileDrop(): void {
  ensureSubscribed();
}

/** Subscribes to dropped paths; returns the unsubscribe function. */
export function onDroppedFiles(fn: DropListener): () => void {
  listeners.add(fn);
  ensureSubscribed();
  return () => {
    listeners.delete(fn);
  };
}
