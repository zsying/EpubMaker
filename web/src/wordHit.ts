// Which word a bare click landed on.
//
// The reader used to require a full selection before it would look anything up,
// which is two gestures where one should do. A single click carries a caret
// position; expanding that position to the surrounding word is enough to look
// it up. Kept as a pure function on a text buffer so the boundary rules are in
// one readable place — the DOM part (turning coordinates into a caret and a
// range into screen space) stays in the reader.

export type WordSpan = { start: number; end: number; word: string };

/** Letters plus the joiners that live inside English words (don't, well-known,
 * and the curly apostrophe EPUB often ships instead of '). Digits are not part
 * of a word here: a page number or a year is not something you look up. */
const WORD_CHAR = /[A-Za-z'\u2019-]/;
const LEAD_JUNK = /^['\u2019-]+/;
const TAIL_JUNK = /['\u2019-]+$/;

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
  if (i >= text.length || !WORD_CHAR.test(text[i])) {
    if (i > 0 && WORD_CHAR.test(text[i - 1])) i -= 1;
    else return null;
  }

  let s = i;
  let e = i + 1;
  while (s > 0 && WORD_CHAR.test(text[s - 1])) s--;
  while (e < text.length && WORD_CHAR.test(text[e])) e++;

  // A quote or hyphen at either edge belongs to the punctuation around the
  // word, not to the word: "the 'hood" must not look up "'hood"... unless it
  // really is that headword, which the dictionary decides from the plain form.
  const raw = text.slice(s, e);
  const lead = raw.length - raw.replace(LEAD_JUNK, '').length;
  const word = raw.slice(lead).replace(TAIL_JUNK, '');
  if (!/[A-Za-z]/.test(word)) return null;

  const start = s + lead;
  return { start, end: start + word.length, word };
}
