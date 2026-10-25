// Placement maths for the reader's floating overlays (selection toolbar,
// dictionary card, annotation popover).
//
// All three are `position: fixed` and centred on a point taken from the text
// they belong to. Anchoring on a word near the window margin used to push half
// the overlay off screen — the card was readable only if the word happened to
// sit near the middle of the window. This module keeps them inside the
// viewport; the React side only measures and feeds the numbers in.

/** A viewport-space point an overlay belongs to: horizontal centre plus the
 * top and bottom edges of the referenced text. */
export type Anchor = { x: number; top: number; bottom: number };

export type Size = { width: number; height: number };

/** Minimum breathing room between an overlay and a viewport edge. */
export const EDGE_GAP = 8;

/**
 * Resolves the top-left position for an overlay of `size` anchored at `anchor`.
 *
 * Horizontally the overlay is centred on the anchor, then pulled back inside so
 * that neither half is clipped. Vertically it prefers `prefer`, flips to the
 * other side when the preferred one has no room, and finally clamps — so an
 * overlay taller than the viewport still shows its top instead of going blank.
 */
export function placeOverlay(
  anchor: Anchor,
  size: Size,
  viewport: Size,
  prefer: 'above' | 'below',
  gap: number,
): { left: number; top: number } {
  const half = size.width / 2;
  const minLeft = half + EDGE_GAP;
  // The inner max() keeps the result sane when the viewport is narrower than
  // the overlay itself: pin to the left edge rather than producing a negative.
  const left = Math.min(
    Math.max(anchor.x, minLeft),
    Math.max(minLeft, viewport.width - half - EDGE_GAP),
  );

  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - EDGE_GAP;
  const fitsAbove = above >= EDGE_GAP;

  let top = prefer === 'below' ? below : above;
  const preferredFits = prefer === 'below' ? fitsBelow : fitsAbove;
  const otherFits = prefer === 'below' ? fitsAbove : fitsBelow;
  if (!preferredFits && otherFits) {
    top = prefer === 'below' ? above : below;
  }
  top = Math.min(
    Math.max(top, EDGE_GAP),
    Math.max(EDGE_GAP, viewport.height - EDGE_GAP - size.height),
  );

  return { left, top };
}
