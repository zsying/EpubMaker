/**
 * Reading preferences shared by the reader's Aa sheet and the Me→设置 page.
 * Both surfaces read and write the very same localStorage keys, so a change
 * made on one is picked up by the next reader mount (routes unmount the
 * reader, so no live-sync is needed).
 */

export const FONT_SIZE_KEY = 'epubmaker.fontSize';
export const MODE_KEY = 'epubmaker.readMode.v2';
export const THEME_KEY = 'epubmaker.readTheme';
export const FONT_FAMILY_KEY = 'epubmaker.readFont';
export const FONT_OVERRIDE_KEY = 'epubmaker.readFontOverride';

export type ReadMode = 'paged' | 'scroll';
export type ReadTheme = 'paper' | 'green' | 'dark';

export const DEFAULT_MODE: ReadMode = 'paged';

/** Override defaults to ON: a picked font should win over whatever families an
 * EPUB embeds, otherwise the choice silently does nothing for most books. */
export function fontOverrideEnabled(): boolean {
  return localStorage.getItem(FONT_OVERRIDE_KEY) !== '0';
}
