/**
 * Which shelf the reader is looking at.
 *
 * Remembered per device, not per book: opening the app comes back to the shelf
 * you were on, the way a file manager comes back to the folder. A remembered id
 * that no longer exists (the shelf was deleted, or this is the first launch
 * after updating) is replaced by the default shelf when ListShelves answers —
 * see Library's loadShelves — so a stale id can never open onto an empty page.
 *
 * The password is NOT part of this: it lives in the backend's memory and dies
 * with the process. Remembering "this shelf is unlocked" across launches would
 * make the lock a decoration.
 */
const KEY = 'epubmaker.shelf';

/** The shelf every book lands on until someone makes another one. */
export const DEFAULT_SHELF_ID = 'default';

export function currentShelfId(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_SHELF_ID;
  } catch {
    return DEFAULT_SHELF_ID;
  }
}

export function rememberShelfId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: the choice just does not survive the session */
  }
}
