import type { TocEntry } from './api';

// Everything about the table of contents that is not geometry (that is
// tocLayout.ts) and not a component (that is components/Toc.tsx): which view
// the reader last chose, and how a nav href is turned into a document or an
// anchor in the rendered chapter.

/** Which list the TOC panel is showing: the book's own outline, or the spine. */
export type TocView = 'nav' | 'file';
export const TOC_VIEW_KEY = 'epubmaker.tocView';

export function readTocView(): TocView | null {
  try {
    const v = localStorage.getItem(TOC_VIEW_KEY);
    return v === 'nav' || v === 'file' ? v : null;
  } catch {
    return null;
  }
}

// Strip any #fragment from a TOC href so a child-section entry
// (doc.xhtml#section) resolves to its parent chapter document (doc.xhtml).
export function docKey(href: string): string {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(0, i) : href;
}

// ---- the two views of one book, never mixed -------------------------------
//
//  * 目录 (nav) — the book's own outline, EPUB3 nav or NCX, exactly as written.
//    It is the only thing that knows what the sections are *called*. It may
//    name several sections inside one document, and it may leave documents out
//    (a cover, a continuation page a converter split off) because its author
//    never thought of them as chapters.
//  * 文件 (files) — the spine, one row per document. It knows every document
//    and nothing about what they are called.
//
// The reader used to weave the two together (ADR-31) so one list reached every
// document, and against 邓小平时代 that produced rows the book never had: its
// last document, whose only title is the English book title, appeared after
// 注 释 as a second title page, and the two sections that share one document
// lit up together — a chapter that looked duplicated. A faithful list of 33
// sections that is a little short of 18 documents is easier to understand than
// 35 rows where two were invented, and the switch is right there.

/** Every nav href that points into `doc`, in outline order. */
export function hrefsInDoc(entries: TocEntry[], doc: string): string[] {
  const out: string[] = [];
  const walk = (es: TocEntry[]) => {
    for (const e of es) {
      if (e.href && docKey(e.href) === doc) out.push(e.href);
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** Rows a nav actually draws (group nodes without an href are not rows). */
export function countTocEntries(entries: TocEntry[]): number {
  let n = 0;
  const walk = (es: TocEntry[]) => {
    for (const e of es) {
      if (e.href) n += 1;
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  return n;
}

/** The `#fragment` a nav entry points at, percent-decoded ('' if it has none). */
export function anchorIdOf(href: string): string {
  const i = href.indexOf('#');
  if (i < 0) return '';
  const raw = href.slice(i + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is still a usable id in most books.
    return raw;
  }
}

/** The rendered element an anchor was rewritten onto (id → data-anc, because
 *  DOMPurify may not keep `id`), or null when the book has no such anchor — a
 *  section that points at its document's top, or one the sanitizer dropped. */
export function anchorElement(root: Element, id: string): Element | null {
  if (!id) return null;
  try {
    return root.querySelector(`[data-anc="${CSS.escape(id)}"]`);
  } catch {
    return null;
  }
}

// Return the node-path keys (the encoding TocNode in components/Toc.tsx builds)
// from the root down to the entry whose document href matches `doc`. Used by
// "locate current chapter" to expand every ancestor group.
export function findTocPath(es: TocEntry[], doc: string, base = ''): string[] {
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    const key = base === '' ? `/${i}` : `${base}/${i}`;
    if (e.href && docKey(e.href) === doc) return [key];
    if (e.children && e.children.length) {
      const sub = findTocPath(e.children, doc, key);
      if (sub.length) return [key, ...sub];
    }
  }
  return [];
}

/** Every key in the outline that has children — i.e. every row that can be
 *  folded. Folded is the resting state of a nested outline: a book with parts
 *  draws as a hundred rows once every group is open, and the rows a reader
 *  never asked for push the ones he wants off the screen. */
function groupKeys(es: TocEntry[], base = ''): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    const key = base === '' ? `/${i}` : `${base}/${i}`;
    if (e.children && e.children.length) {
      out.add(key);
      for (const k of groupKeys(e.children, key)) out.add(k);
    }
  }
  return out;
}

/** The fold state an outline opens with: every group closed, except the path
 *  down to `doc` — the chapter being read. Computed where the outline lands
 *  rather than in an effect, so the first paint is already folded. A `doc` the
 *  outline does not name (a book imported before hierarchy support, or a
 *  document its nav skipped) folds everything. */
export function initialTocFold(es: TocEntry[], doc: string | undefined): Set<string> {
  const folded = groupKeys(es);
  if (doc) for (const k of findTocPath(es, docKey(doc))) folded.delete(k);
  return folded;
}
