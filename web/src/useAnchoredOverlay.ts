import { useLayoutEffect, useRef, useState } from 'react';
import { Anchor, placeOverlay } from './overlay';
import { readViewport } from './device';

// The three floating surfaces in the reader (selection toolbar, dictionary
// card, annotation popover) all hang off one point on the page and all have to
// stay inside the visible area. That is one problem, so it gets one hook.

// Keeps a fixed-position overlay anchored to a point on screen *and* fully
// inside the viewport. Two problems this solves, both visible at the margins of
// the reader: a card centred on a word near the right edge loses half its width
// off-screen, and a card opened near the bottom is cut off vertically.
//
// The size is only known after layout, so the overlay starts hidden and is
// revealed once measured — otherwise it would paint once at its clipped
// position. `revision` re-measures when the content changes height, e.g. when
// the dictionary card grows its "already saved" footer.
//
// Re-measuring on a size change of the element itself, rather than on a list of
// state keys, is what keeps a card that GROWS in place. The dictionary card is
// placed while it is still short and then grows: a cached AI answer arrives a
// moment later (reopening a word that was asked about before), an image or a
// font swap re-wraps the text, "加入生词本" turns into one line of text. Each of
// those pushed the bottom of the card past the window edge, because the clamp
// applied at open time was computed against the old height.
export function useAnchoredOverlay(
  anchor: Anchor | null,
  prefer: 'above' | 'below',
  gap: number,
  revision: unknown,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) {
      setPos(null);
      return;
    }
    const measure = () => {
      const vp = readViewport();
      const next = placeOverlay(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: vp.w, height: vp.h },
        prefer,
        gap,
      );
      // visualViewport fires `scroll` continuously while the page moves under a
      // raised keyboard; re-rendering for an unchanged position would fight the
      // browser for no reason.
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    // The keyboard opening changes visualViewport without necessarily firing a
    // window resize, and it moves the card's anchor with it (scroll). Both are
    // reasons to re-place, not to land the card half under the keyboard.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    // Anything that changes the overlay's own height re-places it. Observing the
    // element is the only way to catch content that arrives asynchronously and
    // silently (the cached AI answer), and it costs nothing when nothing moves:
    // the observer fires on size, and `setPos` returns the previous object when
    // the position is unchanged.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [anchor?.x, anchor?.top, anchor?.bottom, prefer, gap, revision]);

  return { ref, pos };
}

// Overlays are invisible for the single frame before their measured size is
// known, so they never paint once at a clipped position.
export function overlayStyle(pos: { left: number; top: number } | null) {
  return pos
    ? { left: pos.left, top: pos.top, visibility: 'visible' as const }
    : { left: 0, top: 0, visibility: 'hidden' as const };
}
