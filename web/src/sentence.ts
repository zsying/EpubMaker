/* ----------------------------- text-offset helpers -----------------------------
   Offsets are characters counted through the rendered chapter, exactly as
   `textContent` lays them out — annotations, bookmarks, reading progress and
   notebook entries all store their position this way, so these helpers are the
   single definition of "where in the chapter am I". */

import DOMPurify from 'dompurify';
import { stripInvisible } from './wordHit';

/** How chapter markup is cleaned before the reader shows it — and before any
 *  text is measured off it, which is the same thing twice: the offsets only
 *  mean something if both sides see the same characters.
 *
 *  `class` and `id` are stripped on purpose. The book's own stylesheet is never
 *  loaded here, so a class can never style the content it came with — the only
 *  thing it can do is collide with the app's classes. A txt-converted Chinese
 *  EPUB wraps whole chapters in `<div class="main">`, which picks up the app
 *  shell's `.main { overflow-y: auto }`; inside the multicol strip a scroll
 *  container is monolithic — it never splits across columns — and the chapter
 *  paginates to a single page while scroll mode looks fine. Ids collide the
 *  same way (`#root`), and nothing here navigates by DOM id. */
export const CHAPTER_PURIFY = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['script', 'style', 'link'],
  FORBID_ATTR: ['class', 'id'],
};

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

/** The text offset an anchor mark stands at.
 *
 *  An anchor is usually an empty element (`<a data-anc="filepos109"></a>`), so
 *  asking where its own text starts finds nothing — the position is the next
 *  character *after* it. A wrapped anchor (`<a data-anc="x">标题</a>`) points at
 *  its first character instead. Both cases are what a TOC jump needs. */
export function anchorOffset(root: Node, el: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (el.contains(n)) return seen;
    if (el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) return seen;
    seen += (n.textContent || '').length;
  }
  return seen;
}

export function getSelectionOffsets(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  const a = charOffset(root, range.startContainer, range.startOffset);
  const b = charOffset(root, range.endContainer, range.endOffset);
  return b < a ? { start: b, end: a } : { start: a, end: b };
}

/** The text node holding a character offset, with the offset inside it. */
export function textNodeAt(
  root: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
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
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'DL',
  'DT',
  'DD',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'NAV',
  'MAIN',
  'FIGURE',
  'FIGCAPTION',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TD',
  'TH',
  'TR',
  'TABLE',
  'BODY',
]);

/**
 * The innermost block element holding `node` — the box that breaks the text
 * flow. `textContent` has no notion of it: a heading and the paragraph under it
 * are adjacent characters in the flat stream, so anything that expands a range
 * of characters ("the word at this caret") has to ask which block it may not
 * leave.
 */
export function blockOf(root: HTMLElement, node: Node): Element | null {
  let el: Element | null = node.parentElement;
  while (el && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * True when a `<br/>` sits between the two text nodes inside `block`. A forced
 * line break is a break in the text the reader sees but not in `textContent`,
 * so "the word at this caret" would otherwise run from the end of one line into
 * the start of the next. A word cannot be spelled across a line like that.
 */
export function lineBreakBetween(block: Element, a: Node, b: Node): boolean {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const order: Node[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) order.push(n);
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  // Not both inside this block: refuse to join rather than guess.
  if (ia < 0 || ib < 0) return true;
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  for (let i = lo + 1; i < hi; i++) {
    const el = order[i];
    if (el.nodeType === Node.ELEMENT_NODE && (el as Element).tagName === 'BR') return true;
  }
  return false;
}

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

/**
 * How long an example sentence may get before it is windowed around the word.
 *
 * This is deliberately generous. The old cap (220 characters, counted on each
 * side of the word) cut real sentences in half: "Lessons in Chemistry" opens
 * with one 600-character semicolon-linked sentence, and a reader who looked a
 * word up inside it got "...back before anyone knew there'd even" — not a
 * sentence, not even a clause. Half a sentence explains nothing, so the walk
 * now runs to the paragraph's own end and only a block with no sentence
 * terminators at all (a poem, a wall of dialogue, a table) is windowed.
 *
 * 800 is a ceiling, not a target: it leaves room for the longest literary
 * sentence met in practice (Dickens, or a 600-character opening like the one
 * above) while still refusing to hand a chapter's worth of text to a prompt.
 */
const MAX_SENTENCE = 800;

/** Whitespace as the sentence extractor counts it — including the ideographic
 *  space, which is how CJK text represents a break. */
const SPACE = /[\s\u3000]/;

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
  while (s > from && !isStop(text[s - 1])) s--;
  let e = Math.max(s, Math.min(end, to));
  while (e < to && !isStop(text[e])) e++;
  // `e` stops ON the terminator, so the slice has to include it.
  let stop = Math.min(e + 1, to);

  // A block can hold no terminator at all. Rather than hand back a fragment,
  // keep the part around the word and say so with an ellipsis on the side that
  // was cut — a sentence that begins mid-clause should look like one.
  let cutStart = false;
  let cutEnd = false;
  if (stop - s > MAX_SENTENCE) {
    const mid = Math.round((Math.max(s, start) + Math.min(stop, end)) / 2);
    let ws = Math.max(s, mid - Math.round(MAX_SENTENCE / 2));
    let we = Math.min(stop, ws + MAX_SENTENCE);
    ws = Math.max(s, we - MAX_SENTENCE);
    // Never cut a word in half: step out to the nearest space. Chinese has none
    // inside a sentence, so the search is bounded and a cut between characters
    // (which is normal there) is what happens when it runs out.
    let guard = 40;
    while (ws < we && guard-- > 0 && !SPACE.test(text[ws - 1])) ws++;
    guard = 40;
    while (we > ws && guard-- > 0 && !SPACE.test(text[we])) we--;
    cutStart = ws > s;
    cutEnd = we < stop;
    s = ws;
    stop = we;
  }

  // The sentence leaves the reader as TEXT (notebook row, AI prompt): drop the
  // invisible marks the converter left inside words, so "ac\u00ADcused" is not
  // stored as a word nothing can match. The offsets above are untouched — they
  // count the characters that are in the document.
  const body = text.slice(s, stop).replace(/\s+/g, ' ').trim();
  return stripInvisible((cutStart ? '…' : '') + body + (cutEnd ? '…' : ''));
}

/**
 * A context that ends with its own full stop — trailing quotes and brackets
 * allowed, since a sentence of dialogue ends `…go."` rather than `…go.`. A row
 * that does not is a row that was cut, and there is still a chapter to re-cut it
 * from.
 */
const ENDS_CLEAN = /[.!?…]["'”’»)\]]*$/u;

/**
 * Whether a stored context is obviously a fragment rather than the sentence it
 * claims to be: a bare word, a piece that starts with punctuation, one that
 * begins mid-clause, or one that stops before its own full stop. Rows written
 * before the extraction understood hard-wrapped sources (or its 220-character
 * cap) look like this, and can be re-cut from the chapter.
 */
export function looksLikeFragment(context: string, term: string): boolean {
  const s = (context || '').trim();
  if (!s) return true;
  // Our own marker: a windowed sentence is already as complete as the extractor
  // could make it, and re-cutting it produces the same string.
  if (s.startsWith('…')) return false;
  if (s === term.trim()) return true;
  if (!/\s/.test(s)) return true;
  if (/^[^\p{L}\p{N}"'“‘(¡¿]/u.test(s)) return true;
  if (/^[a-z]/.test(s)) return true;
  return !ENDS_CLEAN.test(s);
}
