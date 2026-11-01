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
