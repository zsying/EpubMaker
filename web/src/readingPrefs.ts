/**
 * Reading preferences shared by the reader's Aa sheet and the Me→设置 page.
 * Both surfaces read and write the very same localStorage keys, so a change
 * made on one is picked up by the next reader mount (routes unmount the
 * reader, so no live-sync is needed).
 *
 * The theme is deliberately NOT a reader preference any more: it is an app
 * theme, applied to <html> as a data attribute before React renders, so every
 * surface (shelf, settings, chrome bars, sheets) recolours together through
 * CSS variables. See the html[data-app-theme] blocks in styles.css.
 */

export const FONT_SIZE_KEY = 'epubmaker.fontSize';
export const MODE_KEY = 'epubmaker.readMode.v2';
export const APP_THEME_KEY = 'epubmaker.appTheme';
/** Pre-theme-app key; migrated once so old installs keep their choice. */
export const LEGACY_THEME_KEY = 'epubmaker.readTheme';
export const FONT_FAMILY_KEY = 'epubmaker.readFont';
export const FONT_OVERRIDE_KEY = 'epubmaker.readFontOverride';

export type ReadMode = 'paged' | 'scroll';

/** App-wide themes: two neutrals plus three reading-tuned palettes. */
export type AppTheme = 'light' | 'sepia' | 'green' | 'dark' | 'midnight';

export const APP_THEMES: Array<{ id: AppTheme; label: string }> = [
  { id: 'light', label: '亮白' },
  { id: 'sepia', label: '纸白' },
  { id: 'green', label: '护眼' },
  { id: 'dark', label: '暗黑' },
  { id: 'midnight', label: '墨蓝' },
];

export const DEFAULT_APP_THEME: AppTheme = 'light';

export function isAppTheme(v: unknown): v is AppTheme {
  return APP_THEMES.some((t) => t.id === v);
}

/** Current theme from storage, migrating the old reader-only key once. */
export function appTheme(): AppTheme {
  const stored = localStorage.getItem(APP_THEME_KEY);
  if (isAppTheme(stored)) return stored;
  // Old installs picked a reading background; map it onto the matching app
  // theme so nobody's choice is silently dropped.
  const legacy = localStorage.getItem(LEGACY_THEME_KEY);
  const migrated = legacy === 'dark' ? 'dark' : legacy === 'green' ? 'green' : legacy === 'paper' ? 'sepia' : null;
  if (migrated) {
    localStorage.setItem(APP_THEME_KEY, migrated);
    return migrated;
  }
  return DEFAULT_APP_THEME;
}

/** Writes the choice and applies it to the live document at once. */
export function applyAppTheme(t: AppTheme): void {
  localStorage.setItem(APP_THEME_KEY, t);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.appTheme = t;
  }
}

export const DEFAULT_MODE: ReadMode = 'paged';

/** Override defaults to ON: a picked font should win over whatever families an
 * EPUB embeds, otherwise the choice silently does nothing for most books. */
export function fontOverrideEnabled(): boolean {
  return localStorage.getItem(FONT_OVERRIDE_KEY) !== '0';
}
