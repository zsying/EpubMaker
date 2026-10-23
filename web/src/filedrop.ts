// Dropping an EPUB on the window is the shortest import path there is, but a
// webview cannot do it on its own: the HTML5 drop event hands the page File
// objects with no filesystem path, and this app reads books straight from disk.
// Only the native side can turn a drop into paths.
//
// That is what `DragAndDrop.EnableFileDrop` in main.go is for, and it needs two
// halves: the option, plus a subscription here. With neither, Wails registers no
// listeners at all — not even the `preventDefault` that stops the default action
// — so dropping a file navigates the webview to it instead of importing it.
//
// The subscriber decides what to do; the runtime reports every drop in the
// window (`useDropTarget: false`), because the shelf only holds one small box
// but a file dropped anywhere on it should import.
import { toast } from './toast';

type DropListener = (paths: string[]) => void;

type WailsRuntime = {
  OnFileDrop?: (cb: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean) => void;
};

const listeners = new Set<DropListener>();
let started = false;

function runtime(): WailsRuntime | undefined {
  return (window as unknown as { runtime?: WailsRuntime }).runtime;
}

/** True inside the desktop app, where a drop can be resolved to real paths. */
export function canResolveDropPaths(): boolean {
  return typeof runtime()?.OnFileDrop === 'function';
}

/** Registers the window-wide drop bridge once. Safe to call repeatedly. */
export function initFileDrop(): void {
  if (started) return;
  const rt = runtime();
  if (typeof rt?.OnFileDrop !== 'function') return;
  started = true;
  rt.OnFileDrop((_x, _y, paths) => {
    if (!paths?.length) return;
    if (listeners.size === 0) {
      // Only the shelf imports, and saying so beats a drop that does nothing.
      toast('把 .epub 文件拖到书架才能导入', 'info');
      return;
    }
    for (const fn of [...listeners]) fn(paths);
  }, false);
}

/** Subscribes to dropped paths; returns the unsubscribe function. */
export function onDroppedFiles(fn: DropListener): () => void {
  initFileDrop();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
