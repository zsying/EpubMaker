/** Column helpers shared by the live page strip and the off-screen neighbour. */

/**
 * The column the last rendered character of a chapter is in — i.e. the page the
 * chapter really ends on.
 *
 * The strip is measured by `scrollWidth`, which answers a different question:
 * how much box the content needs. A last block that ends a few pixels past a
 * column edge leaves a column with nothing in it, and taking the box for the
 * text gives the chapter a blank last page — one the reader has to turn past,
 * and the one a backwards chapter turn lands on.
 *
 * Whitespace-only nodes are skipped: they are in the tree but never laid out.
 * `strip` is the multi-column element; `stride` is the distance between two
 * column edges (content width + gap).
 */
export function lastTextPage(
  strip: HTMLElement,
  content: HTMLElement | null,
  stride: number,
): number | null {
  if (!content || stride <= 0) return null;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n.textContent || '';
    if (t.trim()) node = n as Text;
  }
  if (!node) return null;
  const end = (node.textContent || '').trimEnd().length;
  if (end === 0) return null;
  const range = document.createRange();
  range.setStart(node, end - 1);
  range.setEnd(node, end);
  // A character at a soft-hyphen break reports two fragments; the glyph is the
  // last one, and that is where the character actually is (see buildOffsetMap).
  const frags = range.getClientRects();
  let r: DOMRect | null = null;
  for (let i = frags.length - 1; i >= 0; i--) {
    if (frags[i].width > 0) {
      r = frags[i];
      break;
    }
  }
  if (!r) return null;
  const left = strip.getBoundingClientRect().left;
  return Math.max(0, Math.floor((r.left + r.width / 2 - left) / stride));
}
