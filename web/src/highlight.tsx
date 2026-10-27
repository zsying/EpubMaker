import type { ReactNode } from 'react';

/* Characters that occupy no visible space in a sentence but do sit inside the
   string: soft hyphens (a print hyphenation point, U+00AD), zero-width spaces
   and the BOM. EPUB text is full of them — "in­tim­acy" is what the file says —
   and a plain indexOf("intimacy") never matches, so the headword silently went
   unmarked on every card extracted from a book that hyphenates. */
const INVISIBLE = new Set(['\u00AD', '\u200B', '\u200C', '\u200D', '\uFEFF']);

/**
 * The text as it should be compared: no invisible characters, lowercased one
 * character at a time so `at[i]` is the index in `text` of `search[i]`.
 * (Lowercasing the whole string at once can change its length — 'İ' becomes two
 * characters — which would shift the mapping.)
 */
function searchForm(text: string): { search: string; at: number[] } {
  let search = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (INVISIBLE.has(ch)) continue;
    const low = ch.toLowerCase();
    search += low.length === 1 ? low : ch;
    at.push(i);
  }
  return { search, at };
}

/**
 * Marks the headword inside its example sentence, so the row reads as a quote
 * rather than an unexplained string. Falls back to the base form when the
 * stored surface text is inflected differently.
 *
 * `markClass` is the reader's own accent style when the sentence is quoted back
 * inside an AI answer; everywhere else the dotted underline of a notebook row.
 */
export function emphasise(text: string, candidates: string[], markClass = 'vocab-hit'): ReactNode {
  const { search, at } = searchForm(text);
  for (const c of candidates) {
    const needle = searchForm(c.trim()).search;
    if (!needle) continue;
    const hit = search.indexOf(needle);
    if (hit < 0) continue;
    // Back to the original string, so the mark keeps the soft hyphens that are
    // inside the word instead of cutting them out of the sentence.
    const start = at[hit];
    const after = hit + needle.length;
    const stop = after < at.length ? at[after] : text.length;
    return (
      <>
        {text.slice(0, start)}
        <mark className={markClass}>{text.slice(start, stop)}</mark>
        {text.slice(stop)}
      </>
    );
  }
  return text;
}
