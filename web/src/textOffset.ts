// Turning between DOM geometry and the character offsets the backend stores.
// Every one of these is pure: text in, offsets or rects out. They live away
// from the reader because a wrong answer here reads as a wrong answer about
// the book — a hyphenated word selected two lines away, a highlight landing on
// the paragraph instead of the sentence — and the maths is easier to check
// when it is not surrounded by a thousand lines of reader.

/** A range that can be wrapped by applyHighlights. Real annotations satisfy it
 * structurally; the anchor mark is a bare literal. */
export type Highlight = { id: string; startOffset: number; endOffset: number; color?: string };

// Snapshot of a client rect for React state.
export function snapRect(r: DOMRect): { left: number; top: number; right: number; bottom: number } {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

// First and last line fragment of a selection: where the two drag handles sit.
export function selectionEndRects(range: Range): { first: DOMRect; last: DOMRect } | null {
  const list = range.getClientRects();
  if (list.length === 0) return null;
  return { first: list[0], last: list[list.length - 1] };
}

// The line fragment of `rects` that a point falls on, if any.
//
// getBoundingClientRect() is the UNION of those fragments, and one range in
// particular lies about itself: the character right after a soft-hyphen (U+00AD)
// line break — print-converted EPUBs ship them inside words — reports an empty
// run at the end of the previous line plus its own glyph, so the union is a box
// as wide as the column and two lines tall. Every point on the following line
// then looks like it sits on that one character, and every tap there resolves
// to the hyphenated word. Matching fragment by fragment keeps the answer local
// to where the glyph is actually painted.
export function fragmentAt(
  rects: ArrayLike<DOMRect>,
  x: number,
  y: number,
  padX: number,
  padY: number,
): DOMRect | null {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0) continue;
    if (x >= r.left - padX && x <= r.right + padX && y >= r.top - padY && y <= r.bottom + padY) {
      return r;
    }
  }
  return null;
}

// The word a notebook jump points at. Offsets are stored as "where the
// selection started", so the stored surface text is trusted while it still
// matches and a word run is used when it has gone stale or was never stored.
export function wordRangeAt(
  root: HTMLElement,
  offset: number,
  candidates: string[],
): { start: number; end: number } | null {
  const text = root.textContent || '';
  if (offset < 0 || offset >= text.length) return null;
  const rest = text.slice(offset, offset + 64);
  for (const c of candidates) {
    const needle = (c || '').trim();
    if (needle && rest.toLowerCase().startsWith(needle.toLowerCase())) {
      return { start: offset, end: offset + needle.length };
    }
  }
  const m = /^[A-Za-z][A-Za-z'’-]*/.exec(rest);
  return m ? { start: offset, end: offset + m[0].length } : null;
}

// Wraps the character ranges of each annotation in <mark> elements. Operates on
// the raw text nodes of `root` (run after innerHTML is set, before any mutation).
export function applyHighlights(root: HTMLElement, anns: Highlight[]) {
  const sorted = [...anns].sort((x, y) => x.startOffset - y.startOffset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  let global = 0;
  for (const node of textNodes) {
    const len = node.textContent?.length ?? 0;
    const ns = global;
    const ne = global + len;
    global = ne;
    const overlaps = sorted.filter((a) => a.endOffset > ns && a.startOffset < ne);
    if (overlaps.length === 0) continue;

    const frag = document.createDocumentFragment();
    let p = ns;
    for (const a of overlaps) {
      const a0 = Math.max(a.startOffset, ns);
      const a1 = Math.min(a.endOffset, ne);
      if (a0 > p)
        frag.appendChild(document.createTextNode(node.textContent!.slice(p - ns, a0 - ns)));
      const mark = document.createElement('mark');
      mark.className = 'hl hl-' + (a.color || 'yellow');
      mark.dataset.annId = a.id;
      mark.textContent = node.textContent!.slice(a0 - ns, a1 - ns);
      frag.appendChild(mark);
      p = a1;
    }
    if (p < ne) frag.appendChild(document.createTextNode(node.textContent!.slice(p - ns)));
    node.parentNode?.replaceChild(frag, node);
  }
}
