import { useEffect, useRef } from 'react';

/**
 * Hardware-back discipline for Android.
 *
 * The WebView's back button pops browser history: Wails' MainActivity calls
 * webView.goBack() whenever it can, and shows the 退出 prompt once nothing is
 * left. That is exactly the right primitive for "回退应该依据操作层级来退" —
 * a hardware back walks the navigation stack one level at a time. Two things
 * built on top of it:
 *
 * 1. Overlays (drawers, sheets, the word card, a selection) are React state,
 *    not history entries — a raw history pop would throw the whole page away
 *    just to close a menu, and at a top-level page there would be nothing to
 *    pop at all. So every overlay PUSHES a sentinel entry while it is open.
 *    The capture-phase popstate guard below intercepts a pop into a sentinel,
 *    closes that one overlay, and hides the pop from react-router: one
 *    hardware back always means exactly one UI layer, newest first, and the
 *    page underneath never changes.
 * 2. Some jumps must not be fully reversible: deliberate exits and mode
 *    switches use navigate(..., { replace: true }) so "back" never resurrects
 *    a page the reader left on purpose (e.g. a preview visit turned into
 *    normal reading).
 *
 * React-router subscribes in the bubble phase, so stopImmediatePropagation
 * from a capture listener reliably hides a consumed pop from the router.
 */

// One open overlay. The sentinel history entry it pushed carries the same URL
// as the page, so even a stray late pop of it can never navigate anywhere.
type Closer = { close: () => void };

const stack: Closer[] = [];
// Our own sentinel drops (when an overlay is closed by its UI, not by back)
// also produce a popstate; the guard must let those pass instead of treating
// them as a hardware back on the next overlay.
let droppingOwn = 0;

/** Forgets every registered overlay. Runs when the route changes: closers are
 * page-scoped, and a stale closer from a page that is gone must never eat a
 * legitimate back press. (A leftover sentinel entry is harmless: same URL.) */
export function clearBackClosers() {
  stack.length = 0;
}

/** Installs the capture-phase popstate guard. Call once, before React mounts. */
export function installBackGuard() {
  window.addEventListener(
    'popstate',
    (e) => {
      if (droppingOwn > 0) {
        droppingOwn--;
        return; // our own cleanup, not a hardware back
      }
      const top = stack[stack.length - 1];
      if (!top) return; // no overlay: a genuine navigation, the router takes it
      stack.pop();
      top.close();
      // The popped entry was this overlay's sentinel; the page entry below is
      // current now, which is exactly where the UI already is.
      e.stopImmediatePropagation();
    },
    true,
  );
}

/** While `active`, one hardware back closes the overlay instead of leaving the
 * page. Nesting is LIFO by open time — the newest overlay wins. */
export function useBackClose(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    const entry: Closer = { close: () => closeRef.current() };
    stack.push(entry);
    // Sentinel: a history entry that exists only to be consumed by back. It
    // clones the router's state (plus the marker) and keeps the current URL.
    history.pushState({ ...(history.state as object | null), __backGuard: true }, '');
    let dropped = false;
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      // Closed through its own UI: remove the sentinel we added. Skipped when
      // the route moved underneath us — the stale entry is inert then.
      if (!dropped && (history.state as { __backGuard?: boolean } | null)?.__backGuard) {
        dropped = true;
        droppingOwn++;
        history.back();
      }
    };
  }, [active]);
}
