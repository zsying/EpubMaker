/**
 * Device capabilities that more than one part of the app has to agree on.
 *
 * These live here rather than beside their first caller because each of them
 * has a second caller sooner or later, and a capability copied into two files
 * is a capability that will one day disagree with itself: the reader decides
 * it is on a phone while the shelves decide they are on a desktop, and the only
 * symptom is a gesture that works on one screen and not the other.
 *
 * `isTouchPrimary` in particular has to be readable from a plain module because
 * the "no native text selection on touch" rule is applied as a class on <html>,
 * so the stylesheet can act on it without every component threading a prop.
 */

// True on devices whose primary pointer cannot hover — phones and tablets.
//
// `(pointer: coarse)`/`(hover: none)` describe the *primary* pointer, so a
// touchscreen laptop with a trackpad stays "desktop" and keeps the old hover
// behaviour. `any-pointer: fine` is the guard for that case: a device with a
// mouse attached is never treated as touch-primary, even though it also has a
// touchscreen and therefore maxTouchPoints > 0.
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(any-pointer: fine)').matches) return false;
  return (
    window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches
  );
}

/** Flags <html> with `touch-primary` once, at boot. */
export function flagTouchPrimary(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('touch-primary', isTouchPrimary());
}

// Two callers, and they must agree: the shelves skip the press-in animation
// when the reader asked for no moving pictures, and the reader itself refuses a
// chapter hand-off and a page sliding under the thumb for the same reason.
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The reader and every floating surface have to agree on what "the screen"
// is right now, or a card lands under the keyboard while the text above it
// paginates as if the keyboard were not there.

/** True while a field is focused — the case where a soft keyboard is (or is
 * about to be) covering part of the screen. */
function isEditableFocused(): boolean {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (a as HTMLElement).isContentEditable === true;
}

/** The area the user can actually see, as opposed to the layout viewport.
 *
 * With a soft keyboard up these two disagree: `window.innerHeight` keeps
 * reporting the full window while the keyboard covers the bottom third. Every
 * placement decision here — page geometry, word card, selection toolbar — has
 * to be made against the visible area, or the overlay lands under the keyboard
 * and the last lines of the page are hidden behind it. `scale !== 1` means the
 * user has pinch-zoomed, where visualViewport reports the zoomed-in slice; the
 * layout width is still the right basis for laying out text, so it is ignored.
 */
export function readViewport(): { w: number; h: number; keyboard: boolean } {
  const w = window.innerWidth;
  const vv = window.visualViewport;
  const h = vv && vv.scale === 1 ? Math.round(vv.height) : window.innerHeight;
  return { w, h, keyboard: isEditableFocused() };
}
