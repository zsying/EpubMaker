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
  const migrated =
    legacy === 'dark' ? 'dark' : legacy === 'green' ? 'green' : legacy === 'paper' ? 'sepia' : null;
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

/**
 * How far a horizontal drag has to travel before it turns the page.
 *
 * Stored as a level id rather than a pixel count, and the level is a fraction
 * of the page rather than a fixed distance: 100 px is a short flick on a 6"
 * phone and a nervous twitch on a 12" tablet, so a stored number would mean a
 * different gesture on every screen. The fraction is what the reader actually
 * feels — "I have dragged a third of the page" — and it survives rotation and
 * the one/two-page switch.
 *
 * 30% is the value this reader shipped with (`stride * 0.3`, floored at 48 px
 * and capped at 160 px), so 标准 keeps every existing reader's muscle memory
 * untouched; the other two levels scale the fraction and, with it, the floor
 * and the cap — scaling only the fraction would let the 160 px cap swallow the
 * difference on a wide desktop spread.
 */
export const TURN_SENSITIVITY_KEY = 'epubmaker.turnSensitivity';

export type TurnSensitivity = 'light' | 'normal' | 'firm';

/** `pct` is the share of one spread's width; the multiplier derives from it. */
export const TURN_SENSITIVITY_LEVELS: Array<{
  id: TurnSensitivity;
  label: string;
  pct: number;
}> = [
  { id: 'light', label: '灵敏', pct: 15 },
  { id: 'normal', label: '标准', pct: 30 },
  { id: 'firm', label: '稳重', pct: 50 },
];

export const DEFAULT_TURN_SENSITIVITY: TurnSensitivity = 'normal';

/** The fraction the shipped gesture was tuned to; every level scales off it. */
const TURN_BASE_PCT = 30;

export function isTurnSensitivity(v: unknown): v is TurnSensitivity {
  return TURN_SENSITIVITY_LEVELS.some((l) => l.id === v);
}

export function turnSensitivity(): TurnSensitivity {
  const v = localStorage.getItem(TURN_SENSITIVITY_KEY);
  return isTurnSensitivity(v) ? v : DEFAULT_TURN_SENSITIVITY;
}

export function turnLevelPct(level: TurnSensitivity): number {
  return TURN_SENSITIVITY_LEVELS.find((l) => l.id === level)?.pct ?? TURN_BASE_PCT;
}

/** 1 for 标准, 0.5 for 灵敏, 5/3 for 稳重 — what every threshold multiplies by. */
export function turnLevelFactor(level: TurnSensitivity): number {
  return turnLevelPct(level) / TURN_BASE_PCT;
}

/**
 * The two distances the release decision needs, for a given spread width.
 *
 * `far` is the travel that counts as a deliberate drag; `flickFloor` is the
 * much shorter travel a fast flick still needs, because a flick says "next"
 * by itself. Both scale with the level: a reader who picked 稳重 to stop the
 * page from turning under a stray thumb does not want a 16 px twitch to be
 * enough just because it was fast.
 */
export function turnThresholds(
  level: TurnSensitivity,
  stride: number,
): { far: number; flickFloor: number } {
  const factor = turnLevelFactor(level);
  return {
    // stride is 0 until the first measure; the floor keeps that sane.
    far: Math.min(Math.max(stride * (turnLevelPct(level) / 100), 48 * factor), 160 * factor),
    // Never below 12: that is the dead zone the gesture needs before it calls
    // a touch a drag at all, so a shorter floor is a promise the reader cannot
    // keep — and 灵敏's 8 would be such a promise.
    flickFloor: Math.max(12, Math.round(16 * factor)),
  };
}

/** Override defaults to ON: a picked font should win over whatever families an
 * EPUB embeds, otherwise the choice silently does nothing for most books. */
export function fontOverrideEnabled(): boolean {
  return localStorage.getItem(FONT_OVERRIDE_KEY) !== '0';
}

/**
 * Tapping the left or right edge of the page turns it (paged mode only).
 *
 * ADR-43 removed tap-to-turn because a zone wide enough to hit is a zone that
 * eats the first characters of every line: the only honest geometry on a phone
 * was the 22px text margin. That trade-off has not changed — what changed is
 * who owns the decision. This is a switch, so a reader who turns it on has said
 * "I would rather tap than drag", and the cost (a tap on a word inside the
 * strip turns the page; a press still selects it) is his to accept.
 *
 * Off by default, and that is the whole point: `dictmiss` went red the moment
 * this shipped on — it picks a word near the left margin, and the tap turned the
 * page instead of opening the card. A reader who never asked for tap zones must
 * not lose the edge of every line to them. The switch is on the Aa sheet's first
 * screen and on Me→设置, so asking for it costs one tap, once.
 */
export const TAP_TURN_KEY = 'epubmaker.tapTurn';

/**
 * Share of ONE page's width on each side. Measured per page, not per spread,
 * so a two-page view keeps the same physical target as a one-page view — the
 * reader aims at the edge of the paper, not at a percentage of the window.
 *
 * 18% is 65px on a 360px phone: comfortably above the ~44px a thumb needs,
 * and narrow enough that the middle 64% still opens the chrome. Wider (the
 * quarter 微信读书 uses) starts swallowing whole lines of a 4-char-wide column.
 */
export const TAP_TURN_PCT = 18;

/** Only '1' turns it on; absent means off, which is what a fresh install gets. */
export function tapTurnEnabled(): boolean {
  return localStorage.getItem(TAP_TURN_KEY) === '1';
}
