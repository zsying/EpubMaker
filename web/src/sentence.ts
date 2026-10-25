/* ----------------------------- text-offset helpers -----------------------------
   Offsets are characters counted through the rendered chapter, exactly as
   `textContent` lays them out — annotations, bookmarks, reading progress and
   notebook entries all store their position this way, so these helpers are the
   single definition of "where in the chapter am I". */

import DOMPurify from 'dompurify';

/** How chapter markup is cleaned before the reader shows it — and before any
 *  text is measured off it, which is the same thing twice: the offsets only
 *  mean something if both sides see the same characters. */
export const CHAPTER_PURIFY = { ADD_ATTR: ['target'], FORBID_TAGS: ['script', 'style', 'link'] };

/** A detached chapter container: the markup the reader shows, parsed the way the
 *  reader parses it, and inert — a detached node never fetches an image.
 *
 *  `innerHTML`, not `DOMParser`, on purpose: the same HTML goes through the
 *  fragment parser here and in the reader, and the two disagree. A document
 *  parse drops the leading whitespace of a fragment (the "before head" rules),
 *  which is enough to shift every offset by one character — and offsets are
 *  what annotations, bookmarks and notebook entries are stored as. */
export function chapterHost(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = DOMPurify.sanitize(html, CHAPTER_PURIFY);
  return host;
}

export function charOffset(root: Node, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === node) return count + offset;
    count += (n.textContent || '').length;
  }
  return count;
}

/** Where the first character inside an element sits in the root's text. */
function elementStart(root: Node, el: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (el.contains(n)) return seen;
    seen += (n.textContent || '').length;
  }
  return seen;
}

export function getSelectionOffsets(root: HTMLElement, range: Range): { start: number; end: number } | null {
  const a = charOffset(root, range.startContainer, range.startOffset);
  const b = charOffset(root, range.endContainer, range.endOffset);
  return b < a ? { start: b, end: a } : { start: a, end: b };
}

/** The text node holding a character offset, with the offset inside it. */
export function textNodeAt(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const len = (n.textContent || '').length;
    if (seen + len > offset) return { node: n as Text, offset: offset - seen };
    seen += len;
  }
  return null;
}

/* A sentence lives inside one block — a paragraph, a list item, a heading. HTML
   carries no such thing as "end of sentence", only end of block. */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
  'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN', 'FIGURE', 'FIGCAPTION', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'TR', 'TABLE', 'BODY',
]);

/** The text range of the innermost block element holding `offset`. */
function blockBounds(root: HTMLElement, offset: number): { from: number; to: number } {
  const total = (root.textContent || '').length;
  const at = textNodeAt(root, offset);
  if (!at) return { from: 0, to: total };
  let el: Element | null = at.node.parentElement;
  while (el && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) {
      const from = elementStart(root, el);
      return { from, to: from + (el.textContent || '').length };
    }
    el = el.parentElement;
  }
  return { from: 0, to: total };
}

// A paragraph-long sentence cannot bloat a notebook entry, so the walk is capped
// on both sides.
const SENTENCE_CAP = 220;

/**
 * The sentence surrounding [start,end) in the rendered chapter text. Used as the
 * example context saved alongside a looked-up word.
 *
 * The scan stops at a sentence terminator and at the edges of the paragraph the
 * word sits in — never at a line break. EPUB sources are hard-wrapped: the
 * markup says "…for minimal\ncompensation. He later wrote…", and counting that
 * "\n" as a sentence end is what used to leave entries holding nothing but
 * "compensation." — the word with its own full stop and no sentence.
 */
export function sentenceAt(root: HTMLElement, start: number, end: number): string {
  const text = root.textContent || '';
  const { from, to } = blockBounds(root, start);
  const isStop = (c: string) => c === '.' || c === '!' || c === '?';
  let s = Math.max(from, Math.min(start, to));
  while (s > from && start - s < SENTENCE_CAP && !isStop(text[s - 1])) s--;
  let e = Math.max(s, Math.min(end, to));
  while (e < to && e - end < SENTENCE_CAP && !isStop(text[e])) e++;
  return text
    .slice(s, Math.min(e + 1, to))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a stored context is obviously a fragment rather than the sentence it
 * claims to be: a bare word, a piece that starts with punctuation, or one that
 * begins mid-clause. Rows written before the extraction understood hard-wrapped
 * sources look like this, and can be re-cut from the chapter.
 */
export function looksLikeFragment(context: string, term: string): boolean {
  const s = (context || '').trim();
  if (!s) return true;
  if (s === term.trim()) return true;
  if (!/\s/.test(s)) return true;
  if (/^[^\p{L}\p{N}"'“‘(¡¿]/u.test(s)) return true;
  return /^[a-z]/.test(s);
}
