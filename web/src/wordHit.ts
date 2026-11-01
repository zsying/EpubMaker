// Which word a bare click landed on.
//
// The reader used to require a full selection before it would look anything up,
// which is two gestures where one should do. A single click carries a caret
// position; expanding that position to the surrounding word is enough to look
// it up. Kept as a pure function on a text buffer so the boundary rules are in
// one readable place — the DOM part (turning coordinates into a caret and a
// range into screen space) stays in the reader.

export type WordSpan = { start: number; end: number; word: string };

/** Joiners that live INSIDE English words but must be stripped from the query:
 * the curly apostrophe EPUBs ship instead of ', and the invisible characters
 * converters sprinkle inside words (soft hyphens from print layouting, zero
 * width spaces from web-sourced text). They join the word for EXPANSION —
 * "conversa·tion" must expand as one word — but never reach the dictionary. */
const JOINERS = "'’-\u00AD\u200B\u200C\u200D";
const INVISIBLE = /[\u00AD\u200B\u200C\u200D\uFEFF]/g;

/** Drops the invisible marks a print/web conversion leaves inside words.
 *  They are layout artifacts, not content: the page reads "accused" whether or
 *  not the typesetter put a soft hyphen between "ac" and "cused", so anything
 *  leaving the reader as TEXT (a lookup key, a sentence shown in the notebook,
 *  an AI prompt) should not carry them. Offsets keep them — an offset counts
 *  the characters that are actually in the document. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, '');
}

/** Kana + Han blocks: never part of a latin word. A run of Han is a sentence,
 * not a word — the reader selects a single character for those instead. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isWordChar(c: string | undefined): boolean {
  if (!c) return false;
  if (JOINERS.includes(c)) return true;
  // Letters and combining marks (café, naïve, Pokémon). Digits stay out: a page
  // number or a year is not something you look up.
  if (!/\p{L}|\p{M}/u.test(c)) return false;
  return !CJK.test(c);
}

/** True when the character belongs to the kana/Han blocks. */
export function isCJK(c: string | undefined): boolean {
  return !!c && CJK.test(c);
}

/**
 * The word in `text` that owns caret position `index`, or null when the
 * position is not on a word at all (whitespace, punctuation, CJK, digits).
 *
 * `index` is a caret position, and a caret sits *between* characters, so both
 * neighbours are considered: clicking the right half of a glyph resolves to the
 * position just after it, and testing only `text[index]` would miss the word.
 */
export function wordAt(text: string, index: number): WordSpan | null {
  if (index < 0 || index > text.length) return null;

  let i = index;
  if (i >= text.length || !isWordChar(text[i])) {
    if (i > 0 && isWordChar(text[i - 1])) i -= 1;
    else return null;
  }

  let s = i;
  let e = i + 1;
  while (s > 0 && isWordChar(text[s - 1])) s--;
  while (e < text.length && isWordChar(text[e])) e++;

  // A quote or hyphen at either edge belongs to the punctuation around the
  // word, not to the word: "the 'hood" must not look up "'hood"... unless it
  // really is that headword, which the dictionary decides from the plain form.
  const raw = text.slice(s, e);
  let lead = 0;
  while (lead < raw.length && JOINERS.includes(raw[lead]) && raw[lead] !== '\u00AD') lead++;
  let tail = raw.length;
  while (tail > lead && JOINERS.includes(raw[tail - 1]) && raw[tail - 1] !== '\u00AD') tail--;
  const word = raw.slice(lead, tail).replace(INVISIBLE, '');
  if (!/\p{L}/u.test(word)) return null;

  return { start: s + lead, end: s + tail, word };
}
