/**
 * Device capabilities that CSS also needs to know about.
 *
 * `isTouchPrimary` used to live in the reader, but the "no native text
 * selection on touch" rule has to apply from a plain class on <html> so the
 * stylesheet can act on it without every component threading a prop.
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
