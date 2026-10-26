import { useEffect, useRef } from 'react';

/**
 * Hardware-back discipline for Android.
 *
 * The WebView's back button pops browser history: Wails' MainActivity calls
 * webView.goBack() whenever it can, and shows the 退出 prompt once nothing is
 * left. That is exactly the right primitive for "回退应该依据操作层级来退" —
 * a hardware back walks the navigation stack one level at a time. Two things
 * are built on top of it:
 *
 * 1. Overlays (drawers, sheets, the word card, a selection) are React state,
 *    not history entries — a raw history pop would throw the whole page away
 *    just to close a menu, and at a top-level page there would be nothing to
 *    pop at all. So while any overlay is open, ONE sentinel entry sits above
 *    the page entry. The capture-phase popstate guard below intercepts a pop
 *    into that sentinel, closes the newest overlay, and hides the pop from
 *    react-router: one hardware back always means exactly one UI layer, newest
 *    first, and the page underneath never changes.
 * 2. Some jumps must not be fully reversible: deliberate exits and mode
 *    switches use navigate(..., { replace: true }) so "back" never resurrects
 *    a page the reader left on purpose.
 *
 * Why exactly one sentinel, not one per overlay
 * ---------------------------------------------
 * One-per-overlay looked natural and was wrong. Each overlay's cleanup decided
 * "did the pop I just saw consume MY sentinel?" by looking at history.state,
 * but in a nested stack (word card → AI panel) the entry it found could be the
 * other overlay's sentinel, so it dropped that one instead. The bookkeeping
 * then lost a layer: the NEXT back popped a real page entry, the guard swallowed
 * it to close an overlay, and the URL and the screen ended up on different
 * pages — which is how "swipe back to leave the reader" produced a blank screen
 * and, after a few more swipes, the exit prompt while the reader was still
 * showing.
 *
 * With a single sentinel there is nothing to tell apart: it exists iff at least
 * one overlay is open, it is pushed when the stack goes empty→non-empty, and
 * dropped when it goes back to empty. A hardware back re-pushes a fresh one if
 * overlays remain, so the next press has something to consume again. The count
 * can never drift from the truth, because it is derived from the stack.
 *
 * A sentinel is never a page (2026-10-26)
 * ---------------------------------------
 * The sentinel copies the current URL, so it is indistinguishable from the page
 * it sits on — except by the marker. Two rules keep it from ever being mistaken
 * for one:
 *
 *   - An app navigation while it is on top does not stack a page above it. The
 *     copy would end up BURIED under the new page, where `history.back()` can no
 *     longer reach it, and the next back press would pop the copy and re-render
 *     the page behind it: 生词本 → 书籍正文 → 生词本 → 书架. So pushState is
 *     turned into replaceState while a sentinel is up — the fake entry becomes
 *     the real page, one press, one level.
 *   - If a marked entry is reached that nobody is tracking (a leftover from an
 *     older build, or a race), it is skipped rather than rendered: the pop is
 *     hidden from the router and one more back is requested.
 *
 * React-router subscribes in the bubble phase, so stopImmediatePropagation
 * from a capture listener reliably hides a consumed pop from the router.
 */

// One open overlay. Closers are registered in open order; the newest wins.
type Closer = { close: () => void };

const stack: Closer[] = [];
// Whether our sentinel entry currently sits above the page entry. 0 or 1.
let sentinel = 0;
// Pops we caused ourselves (closing an overlay through its own UI). A popstate
// must not be read as a hardware back when it is really our own cleanup.
let ownPop = 0;
// Set while the page itself is leaving (an in-app back button with an overlay
// still open). The single pop that follows spans the sentinel and the page, and
// must reach the router as one ordinary navigation.
let leaving = 0;
// Closing an overlay and opening another in the SAME update (word card → AI
// panel) must not drop the sentinel: the stack never truly empties. The drop is
// deferred to the end of the effect flush so the other overlay's effect can
// cancel it.
let dropPending = false;
// The URL the sentinel was pushed on. A pop is only ours if the page has not
// moved since; calling history.back() after a navigation would undo it.
let sentinelURL = '';

// Captured before the guard is installed: everything goes through this one.
const rawPushState = history.pushState.bind(history);

function isSentinelEntry(): boolean {
  return !!(history.state as { __backGuard?: boolean } | null)?.__backGuard;
}

/** Whether our sentinel is really still on top.
 *
 * `replaceState` rewrites the CURRENT entry, so an in-app replace (a chapter
 * change, a preview that became plain reading) silently turns the sentinel into
 * a real page. The flag has to follow the entry, not the other way round, or the
 * next in-app back would step over a page the reader never left. */
function liveSentinel(): boolean {
  if (sentinel && !isSentinelEntry()) {
    sentinel = 0;
    sentinelURL = '';
  }
  return sentinel === 1;
}

function pushSentinel() {
  if (sentinel) return;
  sentinel = 1;
  sentinelURL = location.href;
  // The entry clones the router's state (plus the marker) and keeps the current
  // URL, so even a stray late pop of it can never navigate anywhere.
  rawPushState({ ...(history.state as object | null), __backGuard: true }, '');
}

function cancelPendingDrop() {
  dropPending = false;
}

/** Runs at the end of the current task, after React has finished flushing the
 * effects of this commit — which is where "closed one overlay, opened another"
 * becomes visible as a non-empty stack. A timer would be later than that and
 * could land in the middle of a navigation the reader just started. */
function afterCommit(fn: () => void) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setTimeout(fn, 0);
}

/** Drops the sentinel once the current commit has settled and no overlay is
 * open. Deferred because React runs a closing effect's cleanup before the next
 * overlay's effect: dropping synchronously would pop the sentinel the incoming
 * overlay is about to rely on. */
function scheduleSentinelDrop() {
  if (dropPending) return;
  dropPending = true;
  afterCommit(() => {
    dropPending = false;
    if (stack.length > 0) return; // another overlay took over the sentinel
    if (!sentinel) return;
    sentinel = 0;
    // Only walk back if the current entry really is ours. After a navigation the
    // entry above the page is a route, not a sentinel, and calling back() there
    // would undo the reader's own navigation (or cancel one in flight).
    if (isSentinelEntry() && location.href === sentinelURL) {
      ownPop++;
      history.back();
    }
    sentinelURL = '';
  });
}

/** Forgets every registered overlay. Runs when the route changes: closers are
 * page-scoped, and a stale closer from a page that is gone must never eat a
 * legitimate back press. A pop that was already under way is over by then. */
export function clearBackClosers() {
  stack.length = 0;
  leaving = 0;
}

/** Closes everything open so the page can be left in a single press.
 *
 * The reader's own 返回 must work with a word card on screen — quietly doing
 * nothing because a sentinel ate the pop reads as a dead button. This closes the
 * overlays WITHOUT popping anything; the caller then steps back one page plus
 * one sentinel (`navigationDepth()`), and the single pop that arrives is passed
 * straight to the router. */
export function closeForNavigation() {
  const all = stack.splice(0, stack.length);
  if (liveSentinel()) {
    // The pop that is about to happen crosses this sentinel as well.
    leaving = 1;
    sentinel = 0;
    sentinelURL = '';
  }
  for (const c of all) c.close();
}

/** How many history entries the caller must step over to leave the page: the
 * page itself plus a sentinel if one is really up. */
export function navigationDepth(): number {
  return liveSentinel() ? 2 : 1;
}

/** Installs the capture-phase popstate guard. Call once, before React mounts. */
export function installBackGuard() {
  // A page must never be stacked on top of the sentinel: it would bury it, and
  // the first back press would then pop the buried copy and re-render the page
  // the reader just left (生词本 → 书籍正文 → 生词本 → 书架).
  history.pushState = function patchedPushState(
    state: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    if (!liveSentinel()) return rawPushState(state, unused, url as string);
    sentinel = 0;
    sentinelURL = '';
    stack.length = 0; // the overlays belong to the page we are leaving
    leaving = 0;
    history.replaceState(state, unused, url ?? location.href);
  };

  window.addEventListener(
    'popstate',
    (e) => {
      if (ownPop > 0) {
        ownPop--;
        return; // our own cleanup, not a hardware back
      }
      if (leaving) {
        // We are leaving on purpose: this single pop crosses the sentinel and
        // the page, and the router must handle it like any other navigation.
        leaving = 0;
        sentinel = 0;
        sentinelURL = '';
        stack.length = 0;
        return;
      }
      // The raw flag, not liveSentinel(): by the time popstate runs the browser
      // has already moved onto the page entry, so "the current entry is not the
      // guard" is the NORMAL state of a press that just consumed it. Asking the
      // entry here would make every overlay-eating press look like a real
      // navigation.
      if (sentinel) {
        // This pop consumed the sentinel. Whether anything was open decides
        // where it leaves us: the page entry, or one layer less.
        sentinel = 0;
        const top = stack[stack.length - 1];
        if (!top) return; // nothing to close: a plain back on the page entry
        stack.pop();
        e.stopImmediatePropagation();
        top.close();
        // Still-open overlays need a sentinel for the next press.
        if (stack.length > 0) pushSentinel();
        return;
      }
      if (isSentinelEntry()) {
        // A marked entry nobody tracks. It is a copy of the page behind it, so
        // rendering it would take the reader back INTO the page they left. Hide
        // this pop from the router and step past it: one press stays one level.
        e.stopImmediatePropagation();
        ownPop++;
        history.back();
        return;
      }
      // No sentinel: this is a real navigation. Overlays belong to the page that
      // is leaving, so they go with it. Swallowing the pop here to close one
      // would desync the URL from the screen — the blank-screen bug.
      stack.length = 0;
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
    cancelPendingDrop();
    pushSentinel();
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      // Closed through its own UI (or by a hardware back, which already
      // consumed the sentinel): only the last overlay out has a sentinel to
      // give back, and only if it is still ours.
      if (stack.length === 0) scheduleSentinelDrop();
    };
  }, [active]);
}
