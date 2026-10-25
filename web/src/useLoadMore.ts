import { useEffect, useRef } from 'react';

/**
 * Watches a sentinel placed after the last row and fires when it scrolls into
 * view — how an unbounded list grows one screenful at a time.
 *
 * The scroll root is the app's own `.main` pane rather than the viewport: that
 * pane is the only thing that actually scrolls (the top bar and tab bar sit
 * outside it), so an observer rooted at the window would not see the sentinel
 * come into view on a short page.
 *
 * `active` is false while a page is already in flight, which is what keeps the
 * observer from firing twice for the same offset.
 */
export function useLoadMore(active: boolean, onMore: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const latest = useRef(onMore);

  useEffect(() => {
    latest.current = onMore;
  }, [onMore]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) latest.current();
      },
      {
        root: el.closest('.main'),
        // Fetch a screen early: waiting until the sentinel is actually visible
        // means the reader reaches the end of the list before the next page
        // exists, and the list appears to stall.
        rootMargin: '600px 0px',
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  return ref;
}
