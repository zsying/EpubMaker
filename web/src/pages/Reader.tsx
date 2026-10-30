import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import {
  api,
  Annotation,
  Book,
  Bookmark,
  Chapter,
  ExplainResult,
  LookupResult,
  ParseResult,
  ReadingProgress,
  SummaryResult,
  TocEntry,
} from '../api';
import { Caret } from '../Caret';
import { toast, toastError } from '../toast';
import { Anchor, EDGE_GAP, placeOverlay } from '../overlay';
import { wordAt, isCJK, stripInvisible } from '../wordHit';
import {
  blockOf,
  charOffset,
  getSelectionOffsets,
  CHAPTER_PURIFY,
  lineBreakBetween,
  sentenceAt,
  textNodeAt,
} from '../sentence';
import { speakWord } from '../speech';
import {
  chapterSpans,
  nativeTts,
  OnlinePlayer,
  prepareTts,
  setOnlineFetcher,
  setTtsSink,
  spanIndexAt,
  ttsAvailability,
  webSpeak,
  webStop,
  type Span,
  type TtsEngine,
  type TtsEvent,
} from '../readAloud';
import ListenBar from '../components/ListenBar';
import {
  MODE_KEY,
  FONT_FAMILY_KEY,
  FONT_OVERRIDE_KEY,
  TURN_SENSITIVITY_KEY,
  TURN_SENSITIVITY_LEVELS,
  APP_THEMES,
  appTheme,
  applyAppTheme,
  fontOverrideEnabled,
  turnSensitivity,
  turnThresholds,
  turnLevelFactor,
  type AppTheme,
  type ReadMode,
  type TurnSensitivity,
} from '../readingPrefs';
import { isTouchPrimary } from '../device';
import { closeForNavigation, navigationDepth, useBackClose } from '../backNav';
import FontPicker, { CUSTOM_FONT_FAMILY } from '../components/FontPicker';
import AIPanel from '../components/AIPanel';
import AISentence from '../components/AISentence';
import { TurnPeek } from '../components/TurnPeek';
import { lastTextPage } from '../columns';

const FONT_KEY = 'epubmaker.fontSize';
const TOC_DOCK_KEY = 'epubmaker.tocDocked';

// Width of the docked TOC sidebar (kept in sync with --toc-dock-w in styles.css
// and the .toc sidebar width in scroll mode for visual consistency).
const TOC_DOCK_W = 268;

// Height of the top/bottom band that reveals (or, on touch, toggles) the reader
// chrome. Same band for hover and tap so the affordance is in one place.
const CHROME_EDGE = 64;

/* -------------------------------- 听书 --------------------------------
   A listening session reads the chapter sentence by sentence and keeps a
   window of sentences queued in the engine, so the next one starts without a
   gap and a screen that goes dark does not stop the voice. The reader owns the
   queue position; the engine only reports "this one started / finished".
   Every sentence is a span with chapter-text offsets, which is what lets the
   page turn to it and the band follow it. */

/** How many sentences may be queued ahead of the one being spoken. Four is
 * roughly 15-25 seconds of speech: enough to cover a slow network fetch of the
 * online voice, short enough that skipping forward feels immediate. */
const LISTEN_WINDOW = 4;

const LISTEN_RATE_KEY = 'epubmaker.listen.rate';
const LISTEN_ENGINE_KEY = 'epubmaker.listen.engine';
const LISTEN_VOICE_KEY = 'epubmaker.listen.voice';

/** The rates the bar cycles through. 0.75 for a hard passage, 2 for skimming. */
const LISTEN_RATES = [0.75, 1, 1.25, 1.5, 2];

type ListenState = {
  playing: boolean;
  /** Sentence being spoken right now. */
  index: number;
  engine: TtsEngine;
  rate: number;
  voice: string;
};

type MarkBox = { left: number; top: number; width: number; height: number };

/** True while a field is focused — the case where a soft keyboard is (or is
 * about to be) covering part of the screen. */
function isEditableFocused(): boolean {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (a as HTMLElement).isContentEditable === true;
}

/** The area the user can actually see, as opposed to the layout viewport.
 *
 * With a soft keyboard up these two disagree: `window.innerHeight` keeps
 * reporting the full window while the keyboard covers the bottom third. Every
 * placement decision here — page geometry, word card, selection toolbar — has
 * to be made against the visible area, or the overlay lands under the keyboard
 * and the last lines of the page are hidden behind it. `scale !== 1` means the
 * user has pinch-zoomed, where visualViewport reports the zoomed-in slice; the
 * layout width is still the right basis for laying out text, so it is ignored.
 */
function readViewport(): { w: number; h: number; keyboard: boolean } {
  const w = window.innerWidth;
  const vv = window.visualViewport;
  const h = vv && vv.scale === 1 ? Math.round(vv.height) : window.innerHeight;
  return { w, h, keyboard: isEditableFocused() };
}

// Strip any #fragment from a TOC href so a child-section entry
// (doc.xhtml#section) resolves to its parent chapter document (doc.xhtml).
function docKey(href: string): string {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(0, i) : href;
}

// A hierarchical TOC frequently misses a few spine documents — the collection's
// cover page, continuation pages a converter split out of a chapter (the TOC
// still points at the pre-split document), stray section breaks. Dropping the
// whole outline because of them (the old all-or-nothing gate) flattens books
// whose tree is otherwise perfect — a 23-book 合集 would show one flat list.
// Instead the uncovered chapters are woven back in: at each level of the tree
// the entries keep their places, and missing chapters are inserted at their
// spine position — before the first entry that starts after them, or nested
// under the entry whose document span contains them. The outline stays
// hierarchical and still reaches every chapter, which is the invariant the
// all-or-nothing gate existed to protect.
function mergeTocChapters(
  entries: TocEntry[],
  chapters: Chapter[],
  covered: Set<string>,
): TocEntry[] {
  const missing = chapters.filter((c) => !covered.has(c.id));
  if (entries.length === 0 || missing.length === 0) return entries;
  const spineIdx = new Map<string, number>();
  chapters.forEach((c, i) => spineIdx.set(c.href, i));
  const leaf = (c: Chapter): TocEntry => ({ href: c.href, title: c.title });
  // First spine position the entry's subtree resolves to (undefined = the
  // subtree names no chapter document at all).
  const firstSpine = (e: TocEntry): number | undefined => {
    let best: number | undefined;
    const walk = (x: TocEntry) => {
      if (x.href) {
        const i = spineIdx.get(docKey(x.href));
        if (i !== undefined && (best === undefined || i < best)) best = i;
      }
      for (const k of x.children ?? []) walk(k);
    };
    walk(e);
    return best;
  };
  // `pend` is spine-ordered. Each entry owns the span from its first document
  // up to (excluding) the next sibling's first document; chapters inside the
  // span recurse into its children (a childless entry adopts them as leaf
  // children), chapters before the span flush in front of the entry.
  const merge = (es: TocEntry[], pend: Chapter[]): TocEntry[] => {
    if (pend.length === 0) return es;
    if (es.length === 0) return pend.map(leaf);
    const out: TocEntry[] = [];
    let i = 0;
    es.forEach((e, k) => {
      const start = firstSpine(e);
      const nextStart = k + 1 < es.length ? firstSpine(es[k + 1]) : undefined;
      const at = (c: Chapter) => spineIdx.get(c.href) ?? -1;
      while (start !== undefined && i < pend.length && at(pend[i]) < start) {
        out.push(leaf(pend[i]));
        i++;
      }
      const bucket: Chapter[] = [];
      while (
        i < pend.length &&
        (start === undefined || at(pend[i]) >= start) &&
        (nextStart === undefined || at(pend[i]) < nextStart)
      ) {
        bucket.push(pend[i]);
        i++;
      }
      const kids = e.children?.length ? merge(e.children, bucket) : bucket.map(leaf);
      out.push(kids.length ? { ...e, children: kids } : e);
    });
    // Whatever is left (spine docs after the last anchored entry) trails.
    while (i < pend.length) {
      out.push(leaf(pend[i]));
      i++;
    }
    return out;
  };
  return merge(entries, missing);
}

// Return the node-path keys (matching TocNode's key encoding) from the root down
// to the entry whose document href matches `doc`. Used by "locate current chapter"
// to expand every ancestor group.
function findTocPath(es: TocEntry[], doc: string, base = ''): string[] {
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

// Which TOC nodes count as "current" for the active highlight. We match a node
// by its document (fragment-stripped) href against the open chapter. Fragment-less
// chapter entries are preferred; if the book's TOC has no fragment-less entry for
// this document, we fall back to the first fragment-bearing match.
function computeActiveHrefs(entries: TocEntry[], activeDoc: string): Set<string> {
  const fragLess: string[] = [];
  const any: string[] = [];
  const walk = (es: TocEntry[]) => {
    for (const e of es) {
      if (!e.href) {
        if (e.children) walk(e.children);
        continue;
      }
      if (docKey(e.href) === activeDoc) {
        if (e.href.includes('#')) any.push(e.href);
        else fragLess.push(e.href);
      }
      if (e.children) walk(e.children);
    }
  };
  walk(entries);
  return new Set(fragLess.length ? fragLess : any);
}

// Recursive hierarchical TOC renderer. Collapse state is controlled by the parent
// via `collapsed` (a Set of node-path keys) so a "locate current chapter" action
// can expand ancestors. Indentation comes from the row wrapper. The active node is
// highlighted and clicking a node opens the matching chapter. Group nodes without
// an href are not clickable to open, but their caret still collapses their subtree.
function TocTree({
  entries,
  depth = 0,
  itemClass,
  activeSet,
  resolve,
  onPick,
  collapsed,
  onToggle,
  pathBase = '',
}: {
  entries: TocEntry[];
  depth?: number;
  itemClass: string;
  activeSet: Set<string>;
  resolve: (href: string) => string | undefined;
  onPick: (cid: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  pathBase?: string;
}) {
  return (
    <>
      {entries.map((e, i) => {
        const key = pathBase === '' ? `/${i}` : `${pathBase}/${i}`;
        return (
          <TocNode
            key={key}
            entry={e}
            nodeKey={key}
            depth={depth}
            itemClass={itemClass}
            activeSet={activeSet}
            resolve={resolve}
            onPick={onPick}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        );
      })}
    </>
  );
}

function TocNode({
  entry,
  nodeKey,
  depth,
  itemClass,
  activeSet,
  resolve,
  onPick,
  collapsed,
  onToggle,
}: {
  entry: TocEntry;
  nodeKey: string;
  depth: number;
  itemClass: string;
  activeSet: Set<string>;
  resolve: (href: string) => string | undefined;
  onPick: (cid: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const hasKids = !!entry.children && entry.children.length > 0;
  const open = !collapsed.has(nodeKey);
  const cid = entry.href ? resolve(entry.href) : undefined;
  const active = entry.href ? activeSet.has(entry.href) : false;
  const toggle = (ev: ReactMouseEvent) => {
    ev.stopPropagation();
    onToggle(nodeKey);
  };
  const labelClick = () => {
    if (cid) onPick(cid);
    else if (hasKids) onToggle(nodeKey);
  };
  return (
    <>
      <div className="toc-row" style={{ paddingLeft: depth * 16 }}>
        {hasKids ? (
          <button
            type="button"
            className="toc-caret"
            onClick={toggle}
            aria-label={open ? '折叠' : '展开'}
          >
            <Caret open={open} />
          </button>
        ) : (
          <span className="toc-caret toc-caret-empty" />
        )}
        <button
          type="button"
          className={`${itemClass}${active ? ' active' : ''}${hasKids ? ' group' : ''}`}
          style={{ padding: '7px 12px' }}
          onClick={labelClick}
          title={entry.title}
          disabled={!cid && !hasKids}
        >
          {entry.title || '(无标题)'}
        </button>
      </div>
      {hasKids && open && (
        <TocTree
          entries={entry.children!}
          depth={depth + 1}
          itemClass={itemClass}
          activeSet={activeSet}
          resolve={resolve}
          onPick={onPick}
          collapsed={collapsed}
          onToggle={onToggle}
          pathBase={nodeKey}
        />
      )}
    </>
  );
}
const posKey = (id: string) => `epubmaker.pos.${id}`;

// restore carries a layout-independent source character offset (not a page
// number), so the target page is re-derived from the current layout.
type PageIntent = { type: 'first' | 'last' | 'restore'; offset?: number; cid?: string } | null;

// `y`/`bottom` are the selection's viewport edges: overlays flip from one side
// of the text to the other when there is no room in their preferred direction.
type SelState = {
  x: number;
  y: number;
  bottom: number;
  start: number;
  end: number;
  text: string;
  // Viewport rects of the selection's first and last line fragments — the
  // anchors the drag handles hang from. Plain numbers, not DOMRect, so a
  // stale rect can never alias live layout.
  firstRect?: { left: number; top: number; right: number; bottom: number };
  lastRect?: { left: number; top: number; right: number; bottom: number };
} | null;
// `fresh` marks a popover opened by 批注: the highlight was created a moment
// ago, so the note field takes the cursor. Opening an existing mark must not
// raise the keyboard — the reader may only be changing its colour.
type PopoverState = { x: number; y: number; ann: Annotation; fresh?: boolean } | null;
// `offset`/`context` are captured at lookup time so a manual "add to notebook"
// can still record where the word came from.
type LookupCardState = {
  x: number;
  top: number;
  bottom: number;
  res: LookupResult;
  offset: number;
  context: string;
  /** The word as it appears on the page (invisibles stripped). The dictionary
   * normalises case, so `query` comes back as "melissa" for a name the reader
   * tapped as "Melissa" — fine for a lookup key, wrong for a card that quotes
   * the text back. */
  surface: string;
} | null;

// The AI panel is one surface with three callers (0.4, C 方案): the word card's
// contextual gloss, the selection's sentence parse, the chapter guide. Each
// carries exactly the grounded inputs its Backend call needs — the model never
// invents a word, a sentence or a chapter, it only re-reads what is on screen.
type AIPanelState =
  | { kind: 'explain'; word: string; sentence: string }
  | { kind: 'parse'; sentence: string }
  | { kind: 'summary' }
  | null;

// A page turn the finger is holding. `follow` is the drag itself — the page
// sits exactly where the thumb has dragged it; `settle` is the release, where
// the same slide carries it to whichever end the gesture earned.
type TurnDrag = { dir: 1 | -1; phase: 'follow' | 'settle' };

// Echoes the sentence the word came from with the word itself marked. The
// sentence is plain text lifted off the page, so the only markup in it is the
// one this function adds.
function highlightWord(sentence: string, word: string) {
  if (!word) return sentence;
  const i = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return sentence;
  return (
    <>
      {sentence.slice(0, i)}
      <b className="ai-hl">{sentence.slice(i, i + word.length)}</b>
      {sentence.slice(i + word.length)}
    </>
  );
}

// A visit opened from one of the notebook pages (生词本 / 划线 / 书签): "show me
// this entry in the book". It is a detour, not reading — the position it opens
// at must not become the reading position, which is why the whole session
// disables progress saving AND page turning: a preview that drifts through the
// book would invite exactly the record clobbering the mode exists to prevent.
type Preview = {
  source: 'vocab' | 'annotation' | 'bookmark';
  // What the banner names: the word, the annotated text or the bookmark label.
  label: string;
  offset: number;
  // Annotation jumps carry the full highlighted range to re-select on arrival.
  end?: number;
  // Vocab jumps anchor a single word (surface form first, then the lemma).
  word?: string;
  surface?: string;
};

// Where each preview came from — the label on the banner and the page the
// back button returns to.
const PREVIEW_SOURCE: Record<Preview['source'], { back: string; hint: string }> = {
  vocab: { back: '/vocab', hint: '生词本 · 临时查看，不记录阅读进度' },
  annotation: { back: '/annotations', hint: '划线 · 临时查看，不记录阅读进度' },
  bookmark: { back: '/bookmarks', hint: '书签 · 临时查看，不记录阅读进度' },
};

// Pseudo-annotation id for the word being looked at. Prefixing it keeps it from
// colliding with real annotation ids, and the click handler skips it because
// there is nothing to open.
const ANCHOR_ID = '__vocab_anchor';

/** A range that can be wrapped by applyHighlights. Real annotations satisfy it
 * structurally; the anchor mark is a bare literal. */
type Highlight = { id: string; startOffset: number; endOffset: number; color?: string };

// Keeps a fixed-position overlay anchored to a point on screen *and* fully
// inside the viewport. Two problems this solves, both visible at the margins of
// the reader: a card centred on a word near the right edge loses half its width
// off-screen, and a card opened near the bottom is cut off vertically.
//
// The size is only known after layout, so the overlay starts hidden and is
// revealed once measured — otherwise it would paint once at its clipped
// position. `revision` re-measures when the content changes height, e.g. when
// the dictionary card grows its "already saved" footer.
//
// Re-measuring on a size change of the element itself, rather than on a list of
// state keys, is what keeps a card that GROWS in place. The dictionary card is
// placed while it is still short and then grows: a cached AI answer arrives a
// moment later (reopening a word that was asked about before), an image or a
// font swap re-wraps the text, "加入生词本" turns into one line of text. Each of
// those pushed the bottom of the card past the window edge, because the clamp
// applied at open time was computed against the old height.
function useAnchoredOverlay(
  anchor: Anchor | null,
  prefer: 'above' | 'below',
  gap: number,
  revision: unknown,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) {
      setPos(null);
      return;
    }
    const measure = () => {
      const vp = readViewport();
      const next = placeOverlay(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: vp.w, height: vp.h },
        prefer,
        gap,
      );
      // visualViewport fires `scroll` continuously while the page moves under a
      // raised keyboard; re-rendering for an unchanged position would fight the
      // browser for no reason.
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    // The keyboard opening changes visualViewport without necessarily firing a
    // window resize, and it moves the card's anchor with it (scroll). Both are
    // reasons to re-place, not to land the card half under the keyboard.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    // Anything that changes the overlay's own height re-places it. Observing the
    // element is the only way to catch content that arrives asynchronously and
    // silently (the cached AI answer), and it costs nothing when nothing moves:
    // the observer fires on size, and `setPos` returns the previous object when
    // the position is unchanged.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [anchor?.x, anchor?.top, anchor?.bottom, prefer, gap, revision]);

  return { ref, pos };
}

// Overlays are invisible for the single frame before their measured size is
// known, so they never paint once at a clipped position.
function overlayStyle(pos: { left: number; top: number } | null) {
  return pos
    ? { left: pos.left, top: pos.top, visibility: 'visible' as const }
    : { left: 0, top: 0, visibility: 'hidden' as const };
}

const COLORS = ['yellow', 'green', 'red'] as const;

/* ----------------------------- text-offset helpers ----------------------------- */

// Snapshot of a client rect for React state.
function snapRect(r: DOMRect): { left: number; top: number; right: number; bottom: number } {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

// First and last line fragment of a selection: where the two drag handles sit.
function selectionEndRects(range: Range): { first: DOMRect; last: DOMRect } | null {
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
function fragmentAt(
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
function wordRangeAt(
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
function applyHighlights(root: HTMLElement, anns: Highlight[]) {
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

/* ----------------------------- component ----------------------------- */

export default function Reader() {
  const { id = '', chapterId } = useParams();
  const nav = useNavigate();
  const loc = useLocation();

  // Read once on mount: the router keeps this state for the whole visit, but a
  // chapter change inside the reader must not re-open a preview.
  const entryRef = useRef<Preview | null>(
    (loc.state as { preview?: Preview } | null)?.preview ?? null,
  );
  const [preview, setPreview] = useState<Preview | null>(() => entryRef.current);
  // Mirror for gesture guards (turn / openChapter run in listeners and effects
  // that must not depend on — or trail — a state update).
  const previewRef = useRef<Preview | null>(entryRef.current);
  // Where the reader actually was before being pulled here from the notebook.
  const [origin, setOrigin] = useState<ReadingProgress | null>(null);

  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  // Hierarchical table of contents (empty for books imported before hierarchy support).
  const [toc, setToc] = useState<TocEntry[]>([]);
  // Collapsed hierarchical-group node keys (path-encoded). Controlled so the
  // "locate current chapter" action can expand ancestors.
  const [tocCollapsed, setTocCollapsed] = useState<Set<string>>(new Set());
  const [locateNonce, setLocateNonce] = useState(0);
  const toggleToc = (key: string) =>
    setTocCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const [current, setCurrent] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 17);

  const [mode, setMode] = useState<ReadMode>(
    () => (localStorage.getItem(MODE_KEY) as ReadMode) || 'paged',
  );
  // Theme is app-wide (html[data-app-theme]); the Aa sheet only edits it. A
  // local mirror keeps the picker's tick mark honest while the panel is open.
  const [theme, setTheme] = useState<AppTheme>(() => appTheme());

  // Reading font: 'default' (system) or the file name of a downloaded font.
  // `fontEpoch` increments once the custom face has actually loaded, so the
  // paged layout re-measures against the real metrics instead of the fallback's.
  const [readFont, setReadFont] = useState<string>(
    () => localStorage.getItem(FONT_FAMILY_KEY) || 'default',
  );
  // When on, the picked face beats the families an EPUB embeds (inline CSS or
  // stylesheets would otherwise win the cascade and the choice would appear to
  // do nothing for most books).
  const [fontOverride, setFontOverride] = useState<boolean>(fontOverrideEnabled);
  const [fontEpoch, setFontEpoch] = useState(0);

  // How long a horizontal drag has to be before it turns the page. State so
  // the Aa sheet can change it live, plus a ref because the gesture listeners
  // are registered once per page and would otherwise keep the value they were
  // born with — re-registering them to pick up a slider move would abort a
  // drag that is already in flight.
  const [turnSens, setTurnSens] = useState<TurnSensitivity>(turnSensitivity);
  const turnSensRef = useRef(turnSens);
  turnSensRef.current = turnSens;

  // paged reading state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // How many columns the strip is wide. Not the same as pageCount: the last
  // column can be empty (a block ending a few pixels past a column edge), and
  // the strip still has to be wide enough to hold every column that has text in
  // it. Turnable pages are pageCount; the box is stripCols.
  const [stripCols, setStripCols] = useState(1);
  const [pagesPerView, setPagesPerView] = useState(1);

  /* ---- 听书 ---- */
  const [listen, setListen] = useState<ListenState | null>(null);
  // Rectangles of the sentence being spoken, painted by a fixed layer above the
  // page. Never spans injected into the text: the chapter DOM belongs to React.
  const [listenMarks, setListenMarks] = useState<MarkBox[]>([]);
  const [listenSheet, setListenSheet] = useState(false);
  const [edgeVoices, setEdgeVoices] = useState<Array<{ name: string; label: string }>>([]);
  // Preferences outlive the session; the session snapshots them when it starts
  // so changing the rate mid-chapter is an explicit action, not a side effect.
  const [listenRate, setListenRate] = useState<number>(() => {
    const v = Number(localStorage.getItem(LISTEN_RATE_KEY));
    return LISTEN_RATES.includes(v) ? v : 1;
  });
  const [listenEngine, setListenEngine] = useState<TtsEngine>(() =>
    localStorage.getItem(LISTEN_ENGINE_KEY) === 'online' ? 'online' : 'system',
  );
  const [listenVoice, setListenVoice] = useState<string>(
    () => localStorage.getItem(LISTEN_VOICE_KEY) || 'zh-CN-XiaoxiaoNeural',
  );
  // The engine calls back from outside React, so the handler is reached through
  // a ref that every render refreshes — the alternative is a closure that
  // speaks from a chapter two pages old.
  const listenRef = useRef<ListenState | null>(null);
  listenRef.current = listen;
  const spansRef = useRef<Span[]>([]);
  const pushedRef = useRef(0);
  const onlineRef = useRef<OnlinePlayer | null>(null);
  const listenHandlerRef = useRef<(e: TtsEvent) => void>(() => {});
  const [chromeOpen, setChromeOpen] = useState(false);
  const [chromeHover, setChromeHover] = useState(false);
  // Resolved once: the pointer class of a device does not change mid-session,
  // and every tap handler below branches on it.
  const touchPrimary = useMemo(isTouchPrimary, []);
  // Set when Escape dismisses a chrome bar that the pointer is hovering open.
  // Without it the very next mousemove would raise the bar again, so Escape
  // would never get a second press to leave the reader with. Cleared as soon
  // as the pointer leaves the edge band, which is also how the bar comes back.
  const hoverDismissedRef = useRef(false);

  // page-turn cross-dissolve for CHAPTER turns: while true the whole spread is
  // faded out so a different chapter's HTML (not yet measured) can be swapped
  // with zero lateral motion.
  const [fxOut, setFxOut] = useState(false);
  const fxRef = useRef(false);
  const awaitingChapterRef = useRef(false);

  // Page-turn motion for WITHIN-chapter turns: the column strip slides to the
  // neighbouring page and a shadow band sweeps across the sheet. Held only for
  // the duration of the gesture and deliberately not a permanent CSS
  // transition — every other transform change on that strip (measure, restore,
  // 1<->2 page mode, rotation) must land instantly, or the text would fly in
  // from page 1 whenever the layout is rebuilt.
  const [turnFx, setTurnFx] = useState<{ id: number; dir: 1 | -1 } | null>(null);
  const turnFxSeq = useRef(0);
  const turnFxTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(turnFxTimer.current), []);

  // A page turn the FINGER owns (touch), see beginDragTurn. While the finger is
  // down the page follows it exactly, with no easing at all — a turn that eases
  // is a turn that reports the gesture rather than obeying it. The release
  // decides the rest, and both endings are the same slide, so "half a page,
  // then put it back" is a state the page really passes through.
  //
  // The offset is written straight to the DOM (.reader-drag), never through
  // React: this runs on every touchmove, and a re-render of the reader tree per
  // frame is not something a page turn should cost.
  const [turnDrag, setTurnDrag] = useState<TurnDrag | null>(null);
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  // The neighbouring chapter's page, laid out and waiting one spread off-screen
  // (see TurnPeek). A chapter edge is then a place where the book still turns
  // like a book: the finger pulls the page it is actually going to into view.
  const [peek, setPeek] = useState<{ cid: string; side: 1 | -1; html: string } | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  // The gesture and wheel listeners are registered once per page and hold their
  // own closure; a peek that arrives afterwards has to be visible to them, so it
  // is also mirrored here rather than read from state inside those listeners.
  const peekLive = useRef(peek);
  peekLive.current = peek;
  // Sanitised HTML of chapters already fetched for a peek, so turning back and
  // forth across a boundary does not re-render the chapter each time. Small and
  // bounded: a session only ever visits a handful of neighbours per chapter.
  const peekCache = useRef(new Map<string, string>());
  // Set from the frame the chapter turn lands until the new chapter has been
  // measured and painted: the peek is covering the page during the swap, so
  // nothing underneath it may be exposed first.
  const peekHandoffRef = useRef(false);
  // Measured band geometry, per veil element (see placeBand).
  const bandGeomRef = useRef<{ el: HTMLElement; w: number; bw: number } | null>(null);
  // The live drag: how far the page is pulled, in px, where the finger picked
  // it up, how it must end, and whether the release slide is the thing running
  // now. Deliberately not state — it changes every frame and nothing renders
  // from it.
  const dragTurnRef = useRef<{
    dir: 1 | -1;
    px: number;
    origin: number;
    commit: boolean;
    settling: boolean;
    // What the gesture is turning: a page of this chapter, or — at a chapter
    // edge, with the neighbour's page in the peek — the chapter itself.
    kind: 'page' | 'chapter';
  } | null>(null);
  const dragEndTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(dragEndTimer.current), []);

  // book-page geometry (proportions like a real paperback)
  const [stageWidth, setStageWidth] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  const [sheetWidth, setSheetWidth] = useState(0);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [pageGap, setPageGap] = useState(28);
  const [marginPx, setMarginPx] = useState(34);

  // persisted reading data
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  // overlays
  const [tocOpen, setTocOpen] = useState(false);
  // Mobile reading settings sheet (font size / mode / theme). Phone-only
  // entry point, so it starts closed everywhere.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Docked TOC mode: the chapter list is pinned as a persistent sidebar on the
  // left instead of opening as a transient drawer.
  const [tocDocked, setTocDocked] = useState(() => localStorage.getItem(TOC_DOCK_KEY) === '1');
  const [bmOpen, setBmOpen] = useState(false);
  const [annOpen, setAnnOpen] = useState(false);
  const [sel, setSel] = useState<SelState>(null);
  // The live DOM selection behind `sel`: the anchor the drag handles reshape.
  const selRangeRef = useRef<Range | null>(null);
  // True while the selection is OURS (long-press, handle drag, notebook jump).
  // Blink momentarily reports a programmatic selection as collapsed around
  // touch-gesture boundaries; without this flag every such hiccup tore the
  // toolbar away mid-interaction, so a reshaped selection could never be used.
  const selLockRef = useRef(false);
  // True while a drag handle is being moved. The menu stays on screen (hiding
  // it mid-gesture read as "the menu is gone"), but it stops taking hits: the
  // finger's target is the text above the handle, and a menu sitting over that
  // line would swallow the caret lookup.
  const [selDragging, setSelDragging] = useState(false);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // The colour the next highlight takes. Remembered across marks so 批注 does
  // not quietly use yellow on a page the reader has been marking in green.
  const [markColor, setMarkColor] = useState<string>('yellow');

  // Dictionary card for a word picked out of the page. It is positioned in
  // viewport coordinates and rendered outside the page flow on purpose: this
  // reader paginates by measuring content height, so anything joining the flow
  // would change the page count and throw the reader off their page.
  const [lookupCard, setLookupCard] = useState<LookupCardState>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  // The AI gloss the card already knows about. When this exact word + sentence
  // was explained before, the answer is in the local cache, and the card shows
  // it the moment it opens — no ✦ tap, no network. Cleared with the card.
  const [cardAI, setCardAI] = useState<ExplainResult | null>(null);
  // Whether a dictionary is installed at all. A tap on a word always opens
  // the lookup card — without a dictionary it says so and points at the
  // download in 我的 → 查词词库, which is far better than a dead tap.
  const [dictReady, setDictReady] = useState(false);

  // The AI panel (0.4). Null means no ask is in flight or on screen; every
  // entry point sets a payload and lets <AIPanel> own the rest.
  const [aiPanel, setAIPanel] = useState<AIPanelState>(null);
  // The chapter-guide privacy confirmation, asked on every send (the chapter
  // text leaves the device). Kept apart from the panel so a cancel leaves no
  // trace of the ask at all. `configured` is the preflight: without a provider
  // there is nothing to confirm, only a door to settings.
  const [guideAsk, setGuideAsk] = useState<{
    model: string;
    chars: number;
    configured: boolean;
  } | null>(null);

  // Hardware back closes one overlay per press (newest first), never the page
  // underneath. The keyboard Escape path below peels the same layers on
  // desktop; this is the phone counterpart.
  useBackClose(!!lookupCard, () => setLookupCard(null));
  useBackClose(!!popover, () => setPopover(null));
  useBackClose(!!sel, () => clearSelectionUI());
  useBackClose(settingsOpen, () => setSettingsOpen(false));
  useBackClose(tocOpen, () => setTocOpen(false));
  useBackClose(bmOpen, () => setBmOpen(false));
  useBackClose(annOpen, () => setAnnOpen(false));
  useBackClose(!!aiPanel, () => setAIPanel(null));
  useBackClose(!!guideAsk, () => setGuideAsk(null));

  // 批注 hands the cursor to the note field straight away; opening an existing
  // mark does not, because a keyboard rising over the page someone is only
  // recolouring is an interruption. Cursor at the end: a note is written
  // forwards. Deferred one frame: on the first commit the popover is still
  // measuring itself and paints with visibility:hidden, and a hidden element
  // cannot take focus.
  useEffect(() => {
    if (!popover?.fresh) return;
    const raf = requestAnimationFrame(() => {
      const el = noteRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(raf);
  }, [popover?.fresh, popover?.ann.id]);

  // If this exact question was asked before — same word, same sentence — the
  // answer is already on the device, and the card opens with it showing. The
  // read is cache-only and never calls the provider; a miss changes nothing.
  //
  // This hook lives up here with the other overlay effects on purpose: the
  // component returns early while `loading`, and a hook registered after that
  // return would change the hook count between renders — which React reports
  // by unmounting the whole reader.
  useEffect(() => {
    setCardAI(null);
    if (!lookupCard) return;
    const word = lookupCard.res.entry?.word || lookupCard.surface || lookupCard.res.query;
    const sentence = lookupCard.context;
    if (!word || !sentence) return;
    let alive = true;
    api
      .aiExplainCached(word, sentence)
      .then((r) => {
        if (alive) setCardAI(r ?? null);
      })
      .catch(() => {
        /* a cache read failure is a miss, not a problem for the reader */
      });
    return () => {
      alive = false;
    };
  }, [lookupCard]);

  // The chapter guide lives in the top bar (0.4): reading it is a deliberate
  // act about the whole chapter, so it belongs with 目录/书签 rather than
  // floating over the first page. Reading the settings FIRST is deliberate —
  // the confirmation can then name the provider that receives the text, and
  // when nothing is configured yet it says so and offers the way there instead
  // of letting the send fail afterwards.
  function openGuide() {
    api
      .aiConfig()
      .then((cfg) =>
        setGuideAsk({
          model: cfg.model,
          chars: contentRef.current?.textContent?.length ?? 0,
          configured: cfg.configured,
        }),
      )
      .catch(() => toastError('读取 AI 设置失败'));
  }

  // A jump from the notebook or an annotation list has to be visible, not just
  // correct: this is a transient highlight over the landed-on text.
  const [flash, setFlash] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  // Overlay placement: the selection toolbar prefers the space above the text,
  // the dictionary card and annotation popover the space below. Each flips to
  // the other side when its preferred direction has no room, and all three are
  // clamped sideways, so a word picked at the margin of the window no longer
  // pushes its card partly off screen.
  const selPos = useAnchoredOverlay(
    sel && { x: sel.x, top: sel.y, bottom: sel.bottom },
    'above',
    EDGE_GAP,
    sel?.start,
  );
  const dictPos = useAnchoredOverlay(
    lookupCard && { x: lookupCard.x, top: lookupCard.top, bottom: lookupCard.bottom },
    'below',
    14,
    `${lookupCard?.res.found}-${lookupCard?.res.recorded}`,
  );
  const popPos = useAnchoredOverlay(
    popover && { x: popover.x, top: popover.y, bottom: popover.y },
    'below',
    0,
    popover?.ann.id,
  );

  const mainRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  // The whole reader, including the overlays that float over the stage. The
  // swipe listener hangs off this rather than the stage: the word card and the
  // chrome bars are siblings of the stage, so a touch that starts on one of
  // them never reaches a stage listener.
  const readerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // A bare click on a word is deferred by a few milliseconds before it looks
  // anything up. The mousedown of a double-click cancels the pending lookup, so
  // double-clicking a word to select (and highlight) it never flashes a card on
  // the way to the selection toolbar.
  const wordTimerRef = useRef<number | null>(null);
  // When a drag in the page edge turned a page, the click that follows the
  // mouseup must not turn a second one.
  const dragRef = useRef<{ x: number; y: number; fired: boolean } | null>(null);
  const turnedAtRef = useRef(0);
  const pageIntentRef = useRef<PageIntent>(null);
  // Layout-independent restore target: a source character offset to land on.
  // Kept in a ref (not a one-shot intent) so it survives across measure passes
  // — e.g. when the first measurement happens before the stage is laid out.
  const restoreOffsetRef = useRef<number | null>(null);
  // The chapter a pending restore offset belongs to. Restore offsets and
  // chapter intents may only be consumed by a measure pass whose DOM actually
  // holds that chapter — see htmlChapterRef below.
  const restoreCidRef = useRef<string | null>(null);
  // The chapter whose html was last handed to setHtml. setCurrent immediately
  // re-runs the render effect (the annotation list changed) while the DOM
  // still holds the PREVIOUS chapter, and that pass can beat the
  // RenderChapter fetch on a slow device — landing the previous chapter's
  // last page instead of the new one's. Stamped at setHtml time, in both the
  // success and the failure branch, so a failed load still releases intents.
  const htmlChapterRef = useRef<string | null>(null);
  const locationUsedRef = useRef(false);
  // A selection to raise once the jump target is actually on screen: the
  // notebook hands over the word's offsets, the annotation drawer the line's.
  // Consumed by the next measure pass (paged) or restore (scroll) — both run
  // after the target text exists and is positioned. Only reader-internal jumps
  // (annotation popover) set it; preview visits never raise menus.
  const pendingRevealRef = useRef<{ start: number; end: number } | null>(null);
  // Layout-independent map: sampled source character offsets -> visual page.
  // Used to derive a page number from a stored offset (bookmark / annotation /
  // progress) and vice-versa, so layout changes (font size / window) don't drift.
  const offsetMapRef = useRef<Array<{ offset: number; page: number }>>([]);
  // Always holds the latest measureAndLayout so callbacks captured in long-lived
  // effects (e.g. the ResizeObserver, which only re-binds on mode change) never
  // run a stale closure with outdated state.
  const measureRef = useRef<() => void>(() => {});
  // Guards scheduleMeasure so a burst of resize events (window drag, DPR change)
  // collapses into a single rAF re-measure instead of one per frame.
  const rafRef = useRef<number | null>(null);
  // The geometry source for pagination. We read the WINDOW size (kept fresh on
  // every resize event) rather than an element's clientWidth: inside the Wails
  // WebView2 shell the inner element's clientWidth can lag the native window
  // resize (it updates a frame too late, or not at all), which left the 1<->2
  // page spread frozen at whatever width it first measured. The window object
  // is always current at resize-event time, so we snapshot it here synchronously
  // and let measureAndLayout read from this ref.
  const winSizeRef = useRef<{ w: number; h: number }>({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  });

  // Mirrors tocDocked into a ref so measureAndLayout (which reads the window
  // size from winSizeRef) can also subtract the dock width for page geometry
  // without being re-bound on every toggle.
  const tocDockedRef = useRef(tocDocked);
  tocDockedRef.current = tocDocked;

  /* ---- load book / chapters / persisted data ---- */
  useEffect(() => {
    (async () => {
      try {
        const [b, cs, prog, bms, anns, tocEntries] = await Promise.all([
          api.getBook(id),
          api.listChapters(id),
          api.getProgress(id),
          api.listBookmarks(id),
          api.listAnnotations(id),
          api.bookTOC(id),
        ]);
        setBook(b);
        setChapters(cs);
        setToc(tocEntries ?? []);
        setBookmarks(bms);
        setAnnotations(anns);
        // Kept so a preview can offer "jump to where I actually was".
        setOrigin(prog);

        const exists = (cid: string | undefined) => !!cid && cs.some((c) => c.id === cid);
        const target =
          (chapterId && exists(chapterId) && chapterId) ||
          (prog && exists(prog.chapterId) && prog.chapterId) ||
          cs[0]?.id ||
          null;
        if (prog && prog.chapterId === target && prog.positionOffset > 0) {
          restoreOffsetRef.current = prog.positionOffset;
          restoreCidRef.current = target;
        }
        // A preview visit (生词本 / 划线 / 书签) carries its own anchor, which
        // outranks the saved progress: the whole point is landing on THAT spot.
        // It raises no menus — the anchored highlight alone marks the spot.
        const entry = entryRef.current;
        if (entry && !locationUsedRef.current) {
          restoreOffsetRef.current = entry.offset;
          restoreCidRef.current = target;
          locationUsedRef.current = true;
        }
        if (restoreOffsetRef.current === null) {
          pageIntentRef.current = { type: 'first' };
        }
        setCurrent(target);
      } catch (e) {
        toastError(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /* ---- is there a dictionary to look words up in? ---- */
  useEffect(() => {
    api
      .dictStatus()
      .then((s) => setDictReady(s.installed))
      .catch(() => setDictReady(false));
  }, []);

  /* ---- render current chapter HTML ---- */
  useEffect(() => {
    if (!current) return;
    // A preview visit (生词本 / 划线 / 书签) never writes progress: the reader
    // is here to look at one spot, and opening the book again should return
    // them to where they were actually reading.
    if (mode === 'scroll' && !preview) {
      localStorage.setItem(posKey(id), current);
      // Writing the chapter start here would clobber the position that is about
      // to be restored a moment later, so it only happens when there is nothing
      // to restore and the pane really is at the top.
      if (restoreOffsetRef.current === null) api.saveProgress(id, current, 0, 1).catch(() => {});
    }
    (async () => {
      try {
        const r = await api.renderChapter(id, current);
        htmlChapterRef.current = current;
        setHtml(r.html);
        if (mode === 'scroll') mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      } catch (e) {
        toastError(e);
        htmlChapterRef.current = current;
        setHtml('<p class="muted">章节内容读取失败</p>');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, current]);

  useEffect(() => localStorage.setItem(FONT_KEY, String(fontSize)), [fontSize]);
  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode]);
  // Theme persists through applyAppTheme at pick time; nothing to save here.
  useEffect(() => localStorage.setItem(TOC_DOCK_KEY, tocDocked ? '1' : '0'), [tocDocked]);
  useEffect(() => localStorage.setItem(FONT_FAMILY_KEY, readFont), [readFont]);
  useEffect(
    () => localStorage.setItem(FONT_OVERRIDE_KEY, fontOverride ? '1' : '0'),
    [fontOverride],
  );
  useEffect(() => localStorage.setItem(TURN_SENSITIVITY_KEY, turnSens), [turnSens]);

  // Registers the selected reading font once per change and re-measures the
  // paged layout after the face is really loaded: a font swap changes every
  // text metric, and pagination measured against the fallback would drift
  // until the next relayout. document.fonts.load rejects on a failed fetch
  // (e.g. the font file is gone) — the fallback stays, which is fine.
  useEffect(() => {
    const id = 'rd-custom-font-face';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (readFont === 'default') {
      if (style) style.remove();
      setFontEpoch((e) => e + 1);
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    // The override rule is a !important cascade win over EPUB-embedded
    // font-family declarations; without it most books simply ignore the pick.
    style.textContent =
      `@font-face { font-family: '${CUSTOM_FONT_FAMILY}'; src: url('/fonts/${encodeURIComponent(readFont)}'); font-display: swap; }` +
      (fontOverride
        ? `\n.reader-content, .reader-content * { font-family: '${CUSTOM_FONT_FAMILY}', Georgia, serif !important; }`
        : '');
    document.fonts
      .load(`16px '${CUSTOM_FONT_FAMILY}'`)
      .then(() => setFontEpoch((e) => e + 1))
      .catch(() => {});
  }, [readFont, fontOverride]);

  // The docked TOC is 268px of a 390px phone — 122px left for the text. It is a
  // desktop affordance (and its toggle is hidden on touch); if the desktop
  // session left it pinned, a phone opening the same book would start in an
  // unreadable layout. Unpin it instead of inheriting it.
  useEffect(() => {
    if (touchPrimary) setTocDocked(false);
  }, [touchPrimary]);

  // When the docked sidebar is toggled, the available reading width changes, so
  // re-measure the page geometry (the page size / 1-vs-2 spread must adapt).
  useEffect(() => {
    if (mode !== 'paged') return;
    scheduleMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocDocked, mode]);

  const safeHtml = useMemo(() => DOMPurify.sanitize(html, CHAPTER_PURIFY), [html]);

  const annotationsForChapter = useMemo(
    () => annotations.filter((a) => a.chapterId === current),
    [annotations, current],
  );

  // Scroll-mode counterpart of the paged offset restore. Paged mode resolves
  // the offset to a page during measurement; scrolling mode has no page map, so
  // it moves the container itself once the chapter HTML is committed.
  useEffect(() => {
    if (mode !== 'scroll') return;
    const target = restoreOffsetRef.current;
    if (target === null || !contentRef.current) return;
    restoreOffsetRef.current = null;

    const after = scrollTextTo(target);
    if (!after) return;
    // A jump with a locked selection (annotation / notebook) raises its menu
    // once the text is on screen.
    if (pendingRevealRef.current) {
      const pr = pendingRevealRef.current;
      pendingRevealRef.current = null;
      window.setTimeout(() => revealOffsets(pr.start, pr.end), 80);
    }
    if (preview) return;
    // Landing counts as a position: record it, otherwise a reader who jumps
    // back and leaves immediately would find the old anchor next time.
    if (current) api.saveProgress(id, current, target, 1).catch(() => {});
    setFlash({
      left: after.left - 2,
      top: after.top - 3,
      width: Math.max(after.width, 6),
      height: after.height + 6,
    });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(timer);
  }, [safeHtml, mode, preview]);

  // The word a 生词本 jump points at stays lit for as long as you are on the
  // page — the highlight marks the spot; no menus are raised by themselves.
  useEffect(() => {
    if (mode !== 'scroll' || preview?.source !== 'vocab' || !preview.word) return;
    const el = contentRef.current;
    if (!el || el.querySelector('mark.hl-vocab')) return;
    const r = wordRangeAt(
      el,
      preview.offset,
      [preview.surface, preview.word].filter((s): s is string => !!s),
    );
    if (!r) return;
    applyHighlights(el, [
      { id: ANCHOR_ID, startOffset: r.start, endOffset: r.end, color: 'vocab' },
    ]);
  }, [safeHtml, mode, preview]);

  /* ---- imperatively set content + highlights (paged mode) ---- */
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || mode !== 'paged') return;
    el.innerHTML = safeHtml;
    // The preview word is wrapped exactly like a highlight, so it survives page
    // turns: the markup lives in the chapter, not in a floating layer.
    const anchor =
      preview && preview.word
        ? wordRangeAt(
            el,
            preview.offset,
            [preview.surface, preview.word].filter((s): s is string => !!s),
          )
        : null;
    applyHighlights(
      el,
      anchor
        ? [
            ...annotationsForChapter,
            { id: ANCHOR_ID, startOffset: anchor.start, endOffset: anchor.end, color: 'vocab' },
          ]
        : annotationsForChapter,
    );
    el.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', scheduleMeasure, { once: true });
        img.addEventListener('error', scheduleMeasure, { once: true });
      }
    });
    scheduleMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeHtml, annotationsForChapter, mode, preview]);

  /* ---- measure pages (paged mode) ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
    const stage = stageRef.current;
    // The paged DOM only exists once a chapter has rendered, so the first run of
    // this effect (on mount, before `html` arrives) finds no stage. Depending on
    // `html` is what re-runs it at that point — with only [mode] the listeners
    // were registered once against a null ref and never again, so a window
    // resize, a rotation or a viewport change never re-paginated the book.
    if (!stage) return;
    const update = () => {
      const next = readViewport();
      // A soft keyboard shrinking the view must not re-paginate the chapter: the
      // page count would change while the reader is typing an annotation and
      // change back when the keyboard closes, so the text would jump twice per
      // comment. The overlays follow the keyboard themselves; the page does not.
      if (next.keyboard && next.h < winSizeRef.current.h) return;
      // Snapshot the window size synchronously so measureAndLayout reads a
      // fresh value even if the inner element's clientWidth lags the resize.
      winSizeRef.current = { w: next.w, h: next.h };
      setStageWidth(winSizeRef.current.w);
      setStageHeight(winSizeRef.current.h);
      // Re-measure on every size change so the page count (1 vs 2) and sheet
      // geometry adapt to the window.
      scheduleMeasure();
    };
    // The ResizeObserver catches layout changes of the stage element. In the
    // Wails WebView2 shell a window resize does NOT reliably re-fire a
    // ResizeObserver callback for the inner element, but Wails always dispatches
    // a `window` resize event on window resize — so listen to both.
    //
    // visualViewport is the third source and the only one that fires when a
    // soft keyboard opens without resizing the window (iOS behaves this way;
    // Android reports it as a layout resize but only sometimes, depending on
    // the keyboard's mode).
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    window.addEventListener('resize', update);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      vv?.removeEventListener('resize', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, html]);

  useLayoutEffect(() => {
    if (mode !== 'paged') return;
    measureAndLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, fontSize, mode, stageWidth, stageHeight, fontEpoch]);

  // Builds a layout-independent map: source character offset -> visual page.
  //
  // Measurement happens in the LIVE multi-column layout — the exact same
  // pagination the reader displays — so there is zero drift between what we
  // measure and what is on screen. For each sampled character we read its
  // horizontal position and derive its COLUMN INDEX:
  //     page = floor((charCenterX - columnsLeft) / stride)
  // where stride = contentWidth + columnGap = sheetWidth + pageGap. The column
  // index IS the visual page number.
  //
  // We deliberately measure the live multi-column layout (NOT a single-column
  // stand-in): a single-column stand-in paginates differently from the real
  // multi-column box (per-column bottom rounding drifts), which previously
  // sent every restore to page 1. Measuring the live layout is exact.
  // Whitespace-only text nodes (newlines/indentation between block elements)
  // are never laid out and report a (0,0) rect — those inherit the nearest
  // preceding rendered page (see lastValidPage below) so they don't force a
  // bogus page 1.
  function buildOffsetMap(stride: number) {
    const content = contentRef.current;
    const col = columnsRef.current;
    if (!content || !col || stride <= 0) return;
    const colLeft = col.getBoundingClientRect().left;
    const samples: Array<{ offset: number; page: number }> = [];
    const STEP = 48;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    // Whitespace-only text nodes (the newlines/indentation between block
    // elements) are present in the tree walker and counted in the offset
    // stream, but they are NOT laid out — their Range rect is (0, 0). If we
    // recorded a bogus page 0 for them, a stored offset that happens to fall on
    // one would jump to the first page. Instead inherit the page of the nearest
    // preceding rendered character (whitespace never crosses a page boundary).
    let lastValidPage = 0;
    const pageOf = (node: Text, local: number): number => {
      const len = node.textContent?.length ?? 0;
      const lo = Math.max(0, Math.min(local, len - 1));
      const range = document.createRange();
      range.setStart(node, lo);
      range.setEnd(node, Math.min(lo + 1, len));
      // A character right after a soft-hyphen break reports two fragments: the
      // hyphen at the end of the previous line and its own glyph on the next
      // one. The glyph is the last one, and that is where the offset lands — the
      // union of the two would average into a column the text is not in.
      const frags = range.getClientRects();
      let r: DOMRect | null = null;
      for (let i = frags.length - 1; i >= 0; i--) {
        if (frags[i].width > 0) {
          r = frags[i];
          break;
        }
      }
      if (r) {
        const cx = r.left + r.width / 2;
        let page = Math.floor((cx - colLeft) / stride);
        if (page < 0) page = 0;
        lastValidPage = page;
        return page;
      }
      return lastValidPage;
    };
    let cum = 0;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const len = (n.textContent || '').length;
      samples.push({ offset: cum, page: pageOf(n as Text, 0) });
      for (let o = STEP; o < len; o += STEP) {
        samples.push({ offset: cum + o, page: pageOf(n as Text, o) });
      }
      cum += len;
    }
    offsetMapRef.current = samples;
  }

  // Maps a layout-independent source character offset to the visual page it
  // currently lands on, by binary-searching the offset->page map built by
  // buildOffsetMap() from the live multi-column layout. The map is re-derived
  // from the current geometry on every measure, so font-size / window / DPI
  // changes land on the same text rather than the same (now-wrong) page.
  //
  // We look the offset up in the pre-built map rather than re-measuring the
  // character directly: a direct re-measure walks the text-node stream (which
  // includes whitespace-only nodes between block elements that are never laid
  // out and report a (0,0) rect), and would land on such a node for many
  // offsets, sending the restore to page 1.
  function pageIndexForOffset(offset: number): number {
    const map = offsetMapRef.current;
    if (map.length === 0) return 0;
    if (offset <= map[0].offset) return map[0].page;
    const last = map[map.length - 1];
    if (offset >= last.offset) return last.page;
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (map[mid].offset <= offset) lo = mid;
      else hi = mid - 1;
    }
    return map[lo].page;
  }

  // Returns the source character offset of the first character shown on page `p`,
  // using the sampled map built on every measure.
  function offsetForPage(p: number): number {
    return pageStartOffset(p) ?? offsetMapRef.current.at(-1)?.offset ?? 0;
  }

  // The same lookup, but honest about a page the sampled map never reaches. The
  // map is sampled every 48 characters, so a short last page can have no sample
  // of its own; answering "the last offset in the map" is fine for recording
  // where the reader is, but a caller that maps that offset back to a page lands
  // on the page *before* it — which is how landing on the last page of a chapter
  // got nudged back one page by the next measure.
  function pageStartOffset(p: number): number | null {
    const map = offsetMapRef.current;
    if (map.length === 0) return null;
    for (const s of map) {
      if (s.page >= p) return s.offset;
    }
    return null;
  }

  /* ---- 听书: the session ------------------------------------------------ */

  function listenVoiceLabel(): string {
    return edgeVoices?.find((v) => v.name === listenVoice)?.label || '在线音色';
  }

  /** Silences every engine at once. Called before any restart, so a sentence is
   * never read twice by two engines that both think they are in charge. */
  function clearListenEngine() {
    nativeTts()?.clear();
    onlineRef.current?.stop();
    onlineRef.current = null;
    webStop();
  }

  function pushSpan(i: number, L: ListenState) {
    const span = spansRef.current[i];
    if (!span) return;
    const sid = String(i);
    if (L.engine === 'online') {
      if (!onlineRef.current) onlineRef.current = new OnlinePlayer(L.voice, L.rate);
      onlineRef.current.push(sid, span.text);
      return;
    }
    const native = nativeTts();
    if (native) {
      native.speak(sid, span.text, L.rate);
      return;
    }
    // Desktop: Web Speech is the engine, and the only one that needs no bridge.
    if (!webSpeak(sid, span.text, L.rate)) {
      toast('这台设备没有可用的朗读引擎', 'error');
      stopListen();
    }
  }

  /** Keeps the engine fed, starting at sentence `from`.
   *
   * The window is engine-shaped on purpose. The system engine queues inside
   * Android, where the queue keeps playing with the screen off and JS frozen —
   * so it gets the whole rest of the chapter, and the reading does not stop at
   * the fourth sentence after the phone goes dark. The online voice is fetched
   * per sentence over the network: handing it a whole chapter would mean 40
   * simultaneous requests and no chance to cancel them, so it stays a window. */
  function pumpListen(from: number) {
    const L = listenRef.current;
    if (!L) return;
    const spans = spansRef.current;
    const limit = L.engine === 'system' ? spans.length : from + LISTEN_WINDOW;
    while (pushedRef.current < spans.length && pushedRef.current < limit) {
      pushSpan(pushedRef.current, L);
      pushedRef.current += 1;
    }
  }

  /** On-screen boxes for one sentence, filtered to what is actually visible:
   * the paged strip holds the whole chapter, so an off-page column has real
   * coordinates that would paint the band somewhere off the paper. */
  function spanRects(span: Span): DOMRect[] {
    const root = contentRef.current;
    if (!root) return [];
    const a = textNodeAt(root, span.start);
    const b = textNodeAt(root, Math.max(span.start, span.end - 1));
    if (!a || !b) return [];
    const range = document.createRange();
    range.setStart(a.node, Math.min(a.offset, (a.node.textContent || '').length));
    range.setEnd(b.node, Math.min(b.offset + 1, (b.node.textContent || '').length));
    const view = stageRef.current?.getBoundingClientRect();
    return Array.from(range.getClientRects()).filter((r) => {
      if (r.width < 2 || r.height < 2) return false;
      if (!view) return true;
      return (
        r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom
      );
    });
  }

  function paintListen(span: Span) {
    setListenMarks(
      spanRects(span).map((r) => ({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      })),
    );
  }

  /** Scroll mode has no pages: bring the sentence into view when the reading
   * walks past the bottom of the screen, and leave it alone otherwise (a jump
   * every sentence would feel like the page is being dragged). */
  function revealSpan(span: Span) {
    const scroller = mainRef.current;
    if (!scroller) return;
    const rects = spanRects(span);
    if (rects.length === 0) return;
    const box = scroller.getBoundingClientRect();
    const top = rects[0].top;
    const bottom = rects[rects.length - 1].bottom;
    if (top >= box.top + 24 && bottom <= box.bottom - 24) return;
    scroller.scrollTo({
      top: scroller.scrollTop + (top - box.top) - box.height / 3,
      behavior: 'smooth',
    });
  }

  /** Puts the sentence on screen: turns the page if it lives on another one,
   * then paints the band once the layout has settled. Both frames test that the
   * session is still alive first — a stop that lands inside the two frames would
   * otherwise be followed by a repaint, leaving a band on the page with nothing
   * left to clear it. */
  function showListenSpan(i: number) {
    const span = spansRef.current[i];
    if (!span) return;
    if (mode === 'paged') {
      const target = pageIndexForOffset(span.start);
      if (target !== pageIndex) setPageIndex(target);
      // Two frames: the first lets the strip move, the second measures it.
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          if (listenRef.current) paintListen(span);
        }),
      );
      return;
    }
    window.requestAnimationFrame(() => {
      if (!listenRef.current) return;
      revealSpan(span);
      paintListen(span);
    });
  }

  /** Starts (or restarts) a session at `fromOffset` — the current page, a
   * selection, or the beginning of a chapter that was just opened. */
  function startListen(fromOffset?: number) {
    const avail = ttsAvailability();
    if (!avail.system && !avail.web) {
      toast('这台设备没有可用的朗读引擎', 'error');
      return;
    }
    const spans = chapterSpans(safeHtml);
    if (spans.length === 0) {
      toast('这一章没有可朗读的文字', 'info');
      return;
    }
    const base =
      fromOffset !== undefined
        ? fromOffset
        : mode === 'paged'
          ? offsetForPage(pageIndex)
          : offsetAtViewportTop();
    const at = spanIndexAt(spans, base);
    clearListenEngine();
    spansRef.current = spans;
    pushedRef.current = at;
    const L: ListenState = {
      playing: true,
      index: at,
      engine: listenEngine,
      rate: listenRate,
      voice: listenVoice,
    };
    listenRef.current = L;
    setListen(L);
    prepareTts(L.engine);
    pumpListen(at);
    showListenSpan(at);
  }

  function stopListen() {
    clearListenEngine();
    listenRef.current = null;
    setListen(null);
    setListenMarks([]);
    setListenSheet(false);
  }

  /** Play / pause. Pausing keeps the position: the bar stays, and pressing play
   * again re-reads the sentence that was interrupted. */
  function toggleListen() {
    const L = listenRef.current;
    if (!L) {
      startListen();
      return;
    }
    if (L.playing) {
      clearListenEngine();
      const paused = { ...L, playing: false };
      listenRef.current = paused;
      setListen(paused);
      return;
    }
    const resumed = { ...L, playing: true };
    listenRef.current = resumed;
    setListen(resumed);
    pushedRef.current = L.index;
    pumpListen(L.index);
  }

  function jumpListen(delta: number) {
    const L = listenRef.current;
    if (!L) return;
    const at = Math.max(0, Math.min(spansRef.current.length - 1, L.index + delta));
    clearListenEngine();
    const s = { ...L, index: at, playing: true };
    listenRef.current = s;
    setListen(s);
    pushedRef.current = at;
    pumpListen(at);
    showListenSpan(at);
  }

  function changeListenRate() {
    const i = LISTEN_RATES.indexOf(listenRate);
    setListenRateTo(LISTEN_RATES[(i + 1) % LISTEN_RATES.length]);
  }

  function setListenRateTo(rate: number) {
    setListenRate(rate);
    localStorage.setItem(LISTEN_RATE_KEY, String(rate));
    const L = listenRef.current;
    if (!L) return;
    // The platform applies the rate per utterance, so the current sentence has
    // to start over for the change to be audible now.
    const s = { ...L, rate };
    listenRef.current = s;
    setListen(s);
    if (!L.playing) return;
    clearListenEngine();
    pushedRef.current = L.index;
    pumpListen(L.index);
  }

  function switchListenEngine(engine: TtsEngine) {
    setListenEngine(engine);
    localStorage.setItem(LISTEN_ENGINE_KEY, engine);
    const L = listenRef.current;
    if (!L) return;
    const s = { ...L, engine };
    listenRef.current = s;
    setListen(s);
    clearListenEngine();
    prepareTts(engine);
    pushedRef.current = L.index;
    if (L.playing) pumpListen(L.index);
  }

  function switchListenVoice(voice: string) {
    setListenVoice(voice);
    localStorage.setItem(LISTEN_VOICE_KEY, voice);
    const L = listenRef.current;
    if (!L) return;
    const s = { ...L, voice };
    listenRef.current = s;
    setListen(s);
    clearListenEngine();
    pushedRef.current = L.index;
    if (L.playing) pumpListen(L.index);
  }

  /** Everything the engines report comes through here. Deliberately does not
   * advance on `done`: the next sentence's `start` is what moves the page, so
   * a paused or cleared queue cannot turn pages behind the reader's back. */
  function onTtsEvent(e: TtsEvent) {
    const L = listenRef.current;
    if (!L) return;
    if (e.type === 'start' && e.sid) {
      const i = Number(e.sid);
      if (!Number.isFinite(i) || i < 0 || i >= spansRef.current.length) return;
      if (i !== L.index || !L.playing) {
        const s = { ...L, index: i, playing: true };
        listenRef.current = s;
        setListen(s);
      }
      showListenSpan(i);
      pumpListen(i);
      return;
    }
    if (e.type === 'idle') {
      if (e.code === 'clear' || e.code === 'shutdown') return;
      if (e.code === 'focus_lost') {
        // A call or another player took the audio: pause rather than talk over it.
        const s = { ...L, playing: false };
        listenRef.current = s;
        setListen(s);
        return;
      }
      if (pushedRef.current < spansRef.current.length) {
        pumpListen(L.index);
        return;
      }
      // The chapter is finished: read on into the next one, which is the whole
      // point of 听书 — the reader should not have to turn a page every minute.
      if (next) {
        openChapter(next.id, { type: 'first' });
        return;
      }
      toast('全书已读完', 'success');
      stopListen();
      return;
    }
    if (e.type === 'error') {
      const code = e.code || '';
      if (code === 'no_zh_voice') {
        toast('手机上没有中文语音，请先在系统设置里安装中文朗读引擎', 'error');
        stopListen();
        return;
      }
      if (code === 'init_failed') {
        toast('朗读引擎启动失败', 'error');
        stopListen();
        return;
      }
      if (code === 'online_failed' || code === 'online_playback') {
        // The player has already given up by the time this arrives, so there is
        // nothing left to fight: pause, drop the engine, and say it once.
        toast('在线音色请求失败，可在听书设置里换回系统引擎', 'error');
        const s = { ...L, playing: false };
        listenRef.current = s;
        setListen(s);
        clearListenEngine();
        return;
      }
      // A single failed sentence is not a reason to stop: ask for the next one.
      pumpListen(pushedRef.current);
    }
  }

  function measureAndLayout() {
    const stage = stageRef.current;
    const col = columnsRef.current;
    if (!col) return;

    // A phone is a screen, not a sheet of paper. On a 390x844 viewport the paper
    // ratio (0.72) yielded a 320x444 sheet — half the screen spent on desk
    // surface above and below, and every ~10 lines the reader had to turn the
    // page. On touch the sheet therefore takes the whole stage: no paper ratio,
    // no outer padding, no fake book edges, just a thumb-sized margin around the
    // text. Desktop keeps the paper look it was designed around.
    const fill = touchPrimary;
    const MARGIN = fill ? 22 : 34;
    const GAP = 14;
    const OUTER_PAD_X = fill ? 0 : 44;
    const OUTER_PAD_Y = fill ? 0 : 22;
    const MIN_PAGE_W = 260;
    const PAGE_RATIO = 0.72; // typical Chinese paperback width/height
    const BASE_H = 1000;
    const BASE_W = BASE_H * PAGE_RATIO;
    // Past this, a single line is a mouthful: a landscape phone (844px) is the
    // case that needs two columns, not one very wide one.
    const MAX_COL_W = 620;

    // Drive geometry off the (always-current) window size, NOT an element's
    // clientWidth — see winSizeRef for why this matters under Wails.
    const ws = winSizeRef.current;
    const W = ws.w || (stage ? stage.clientWidth : 1280);
    const H = ws.h || (stage ? stage.clientHeight : 800);
    // The docked TOC sidebar eats horizontal space on the left, so the usable
    // reading width is the window minus the dock. This keeps the book fully
    // visible inside the shrunken stage instead of being clipped by it.
    // (The dock is a desktop affordance; see the effect that turns it off on
    // touch — without that, a dock inherited from the desktop session would
    // leave 122px of text on a 390px phone.)
    const dockW = tocDockedRef.current ? TOC_DOCK_W : 0;
    const effW = Math.max(0, W - dockW);
    const availW = Math.max(320, effW - OUTER_PAD_X * 2);
    const availH = Math.max(260, H - OUTER_PAD_Y * 2);

    let ppv: number;
    let sw: number;
    let sh: number;
    if (fill) {
      // Edge to edge. Two columns only if one would be wider than a comfortable
      // line; portrait phones never qualify, landscape phones do.
      ppv = availW - MARGIN * 2 > MAX_COL_W && availW >= 700 ? 2 : 1;
      sw = Math.floor((availW - (ppv - 1) * GAP) / ppv);
      sh = Math.round(availH);
    } else {
      // Largest single page that fits the available rectangle.
      const singleScale = Math.min(availW / BASE_W, availH / BASE_H);
      const singleW = Math.max(MIN_PAGE_W, Math.round(BASE_W * singleScale));
      const singleH = Math.round(singleW / PAGE_RATIO);

      // Largest page when two are placed side-by-side with a gutter.
      const doubleScale = Math.min(availW / (BASE_W * 2 + GAP), availH / BASE_H);
      const doubleW = Math.round(BASE_W * doubleScale);
      const doubleH = Math.round(doubleW / PAGE_RATIO);

      // Use a two-page spread only if the window is wide enough AND each page
      // would still be comfortably readable. Otherwise scale a single page up.
      ppv = effW >= 900 && doubleW >= MIN_PAGE_W ? 2 : 1;
      sw = ppv === 2 ? doubleW : singleW;
      sh = ppv === 2 ? doubleH : singleH;
    }
    const cw = Math.max(160, sw - MARGIN * 2);
    const ch = sh - MARGIN * 2;

    setSheetWidth(sw);
    setSheetHeight(sh);
    setContentWidth(cw);
    setContentHeight(ch);
    setPageGap(GAP);
    setMarginPx(MARGIN);
    setPagesPerView(ppv);

    // The column gap must position each text column exactly over the printable
    // area of the corresponding sheet: sheet + gap - content width.
    const columnGap = sw + GAP - cw;
    // Distance between the left edges of two adjacent text columns. Equal to
    // contentWidth + columnGap == sheetWidth + pageGap. Used to derive a page
    // (column index) from a character's horizontal position.
    const stride = cw + columnGap;

    // Measure how many columns the content naturally fills at this geometry.
    col.style.width = 'auto';
    col.style.columnWidth = `${cw}px`;
    col.style.columnGap = `${columnGap}px`;
    col.style.height = `${ch}px`;
    const cols = Math.max(1, Math.ceil(col.scrollWidth / (cw + columnGap)));
    // The box is not the text: the box is left wide enough that no column is
    // clipped, but the last column can hold nothing but the tail of a block and
    // then the chapter would offer a blank last page — one the reader has to
    // turn past, and the one a backwards chapter turn lands on. What the reader
    // can turn to is decided by the last character that is really on the page,
    // measured under the width the strip will actually have.
    col.style.width = `${cols * cw + (cols - 1) * columnGap}px`;
    const textPage = lastTextPage(col, contentRef.current, stride);
    const pc = textPage === null ? cols : Math.max(1, Math.min(cols, textPage + 1));
    setStripCols(cols);
    setPageCount(pc);

    // Build the layout-independent offset->page map BEFORE deriving any page,
    // using the geometry we just measured (cw/ch are the local, correct values
    // — reading them from React state here could be stale within this pass).
    buildOffsetMap(stride);

    // Capture the source offset of the currently shown page so a layout change
    // (font size / window / DPI) keeps the same text in view instead of the
    // same (now wrong) page number.
    const keepOffset = pageStartOffset(pageIndex);

    // Same rule as maxPageIndex below: the last spread may be a short one, so
    // the ceiling is the last page-aligned index with content, not pc - ppv.
    const maxIdx = Math.max(0, Math.floor((pc - 1) / ppv) * ppv);
    const intent = pageIntentRef.current;
    // A chapter intent (and a restore offset) may only be consumed by a pass
    // whose DOM holds the intent's chapter: setCurrent re-runs the render
    // effect (the annotation list changed) while the DOM still holds the
    // previous chapter, and on a slow device that pass can beat the
    // RenderChapter fetch. Consuming there lands the PREVIOUS chapter's
    // maxIdx — after the swap the reader sits on a seemingly arbitrary page
    // (device repro: a backward chapter turn stopped at 237/265 instead of
    // 265/265). An unconsumed intent waits for the pass that follows the
    // html swap; the peek handoff and the turn fade hold back with it.
    const intentHere = !!intent && (!intent.cid || intent.cid === htmlChapterRef.current);
    const restoreHere =
      restoreCidRef.current === null || restoreCidRef.current === htmlChapterRef.current;
    let nextPage = 0;
    let landed = false;

    if (restoreOffsetRef.current !== null && restoreHere && offsetMapRef.current.length > 0) {
      // Explicit restore (bookmark / annotation / saved progress): land on the
      // page that currently holds this source offset regardless of layout.
      nextPage = Math.min(pageIndexForOffset(restoreOffsetRef.current), maxIdx);
      restoreOffsetRef.current = null;
      restoreCidRef.current = null;
      landed = true;
    } else if (intentHere && intent?.type === 'last') {
      // Chapter switch backwards: open the previous chapter on its last page.
      nextPage = maxIdx;
      landed = true;
    } else if (intentHere && intent?.type === 'first') {
      // Chapter switch forwards (or TOC jump): open on the first page.
      nextPage = 0;
      landed = true;
    } else if (keepOffset !== null) {
      // Layout change only (font size / window / DPI), same chapter: keep the
      // same text in view rather than the same (now wrong) page number.
      nextPage = Math.min(pageIndexForOffset(keepOffset), maxIdx);
    } else {
      nextPage = Math.min(pageIndex, maxIdx);
    }

    // In two-page mode align the open spread to a physical page boundary.
    if (ppv > 1 && nextPage > 0 && nextPage % ppv !== 0) {
      nextPage = Math.max(0, Math.min(maxIdx, nextPage - (nextPage % ppv)));
    }
    setPageIndex(nextPage);
    if (landed) pageIntentRef.current = null;

    // A jump that wants its target selected (notebook word, annotation line)
    // raises the selection UI once the landed page has painted.
    if (pendingRevealRef.current) {
      const pr = pendingRevealRef.current;
      pendingRevealRef.current = null;
      requestAnimationFrame(() => requestAnimationFrame(() => revealOffsets(pr.start, pr.end)));
    }

    // A cross-chapter turn was faded out and is still waiting (see startTurn).
    // Fade the spread back in ONLY once this measurement has committed the new
    // chapter's page count and starting page — and only when that measurement
    // actually consumed the chapter intent (see intentHere above): fading in
    // on a pass that measured the previous chapter's DOM would reveal the
    // wrong page mid-swap. If (landed) is deferred, the fade holds until the
    // pass that follows the html swap.
    if (awaitingChapterRef.current && landed) {
      awaitingChapterRef.current = false;
      requestAnimationFrame(() => {
        setFxOut(false);
        fxRef.current = false;
      });
    }

    // A chapter turn that had a page to show needed no dissolve: the peek has
    // been covering the sheet since the slide landed, and the chapter loaded
    // behind it. Now that the new page is measured and painted, dropping the
    // drag offset and the peek together is invisible — both show the same page.
    // Hold the drop while the intent is still pending: letting go of the peek
    // on the previous chapter's measure would expose the old text for the
    // rest of the RenderChapter round-trip.
    if (peekHandoffRef.current && landed) {
      peekHandoffRef.current = false;
      requestAnimationFrame(() => {
        dragTurnRef.current = null;
        placeDrag(0, true);
        setTurnDrag(null);
        setPeek(null);
      });
    }
  }
  // Keep the latest measureAndLayout reachable from stable callbacks.
  measureRef.current = measureAndLayout;

  function scheduleMeasure() {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measureRef.current();
    });
  }

  // Moves the reading pane so `target` sits a third of the way down, and
  // returns the on-screen box of that character so the caller can point at it.
  // Extracted because two things need it: the restore that runs when a chapter
  // is rendered, and "back to where I was" inside a detour (same chapter).
  function scrollTextTo(target: number): DOMRect | null {
    const root = contentRef.current;
    const scroller = mainRef.current;
    if (!root || !scroller) return null;
    const hit = textNodeAt(root, target);
    if (!hit) return null;
    const range = document.createRange();
    const end = Math.min(hit.offset + 1, (hit.node.textContent || '').length);
    range.setStart(hit.node, Math.min(hit.offset, end));
    range.setEnd(hit.node, end);

    const rect = range.getBoundingClientRect();
    const top =
      rect.top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'auto' });

    // Measured again after scrolling so the caller's highlight lands on the
    // right line rather than where the text used to be.
    return range.getBoundingClientRect();
  }

  function flashAt(box: { left: number; top: number; width: number; height: number }) {
    setFlash({
      left: box.left - 2,
      top: box.top - 3,
      width: Math.max(box.width, 6),
      height: box.height + 6,
    });
    window.setTimeout(() => setFlash(null), 1400);
  }

  // The character offset at the top of the reading pane. Scrolling has no page
  // map, so this is what turns "where I stopped" into the same kind of anchor
  // the paged reader stores — without it every scroll-mode position collapses
  // to "start of the chapter".
  function offsetAtViewportTop(): number {
    const root = contentRef.current;
    const scroller = mainRef.current;
    if (!root || !scroller) return 0;
    const box = scroller.getBoundingClientRect();
    const x = box.left + Math.min(120, scroller.clientWidth / 2);
    const y = box.top + 6;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = doc.caretRangeFromPoint?.(x, y);
    if (
      caret &&
      caret.startContainer.nodeType === Node.TEXT_NODE &&
      root.contains(caret.startContainer)
    ) {
      return charOffset(root, caret.startContainer, caret.startOffset);
    }
    // Fallback for engines without caretRangeFromPoint: the first text node
    // that reaches past the top edge. Coarse (whole node), still better than 0.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const len = (n.textContent || '').length;
      const r = document.createRange();
      r.selectNodeContents(n);
      if (r.getBoundingClientRect().bottom > y) return seen;
      seen += len;
    }
    return seen;
  }

  /* ---- progress persistence (paged mode) ---- */
  useEffect(() => {
    if (mode !== 'paged' || !current || preview) return;
    const t = setTimeout(() => {
      const off = offsetForPage(pageIndex);
      api.saveProgress(id, current, off, pageCount).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [mode, current, pageIndex, pageCount, id, preview]);

  /* ---- progress persistence (scrolling mode) ---- */
  useEffect(() => {
    if (mode !== 'scroll' || !current || preview) return;
    const scroller = mainRef.current;
    if (!scroller) return;
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        api.saveProgress(id, current, offsetAtViewportTop(), 1).catch(() => {});
      }, 800);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, current, id, preview, safeHtml]);

  const idx = chapters.findIndex((c) => c.id === current);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  const progressPct = chapters.length
    ? ((idx + (pageCount ? pageIndex / pageCount : 0)) / chapters.length) * 100
    : 0;
  const laidOut = sheetWidth > 0 && contentWidth > 0;

  /* ---- 听书: wiring ----------------------------------------------------- */

  // The engines call back from outside React; the handler is refreshed every
  // render so it always speaks for the chapter on screen.
  listenHandlerRef.current = onTtsEvent;

  useEffect(() => {
    setTtsSink((e) => listenHandlerRef.current(e));
    // The online voice is fetched one sentence at a time and handed back as a
    // data URL: an <audio> element plays it with no CORS and no second server.
    setOnlineFetcher(async (text, voice, rate) => {
      const b64 = await api.ttsEdge(text, voice, rate);
      return `data:audio/mpeg;base64,${b64}`;
    });
    return () => {
      setTtsSink(null);
      setOnlineFetcher(null);
      clearListenEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new chapter means a new span list. Reading continues from its beginning —
  // that is also how an automatic chapter turn hands over to the next chapter
  // without the engine ever going quiet for long.
  useEffect(() => {
    const L = listenRef.current;
    if (!L) return;
    const spans = chapterSpans(safeHtml);
    if (spans.length === 0) return;
    spansRef.current = spans;
    pushedRef.current = 0;
    const s = { ...L, index: 0 };
    listenRef.current = s;
    setListen(s);
    pumpListen(0);
    showListenSpan(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeHtml]);

  // The band is geometry, so it has to be re-measured whenever the page it was
  // measured on changed underneath it.
  useEffect(() => {
    const L = listenRef.current;
    if (!L) return;
    const span = spansRef.current[L.index];
    if (!span) return;
    const raf = window.requestAnimationFrame(() => {
      // Re-checked inside the frame: closing the bar between the effect and the
      // frame must not resurrect the band.
      if (listenRef.current) paintListen(span);
    });
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, mode, fontSize, fontEpoch, theme]);

  // The online voice list is only needed by the settings sheet, so it is not
  // fetched on a reading session that never opens it.
  useEffect(() => {
    if (!listenSheet || edgeVoices.length > 0) return;
    api
      .edgeVoices()
      // A backend that answers null (older build, failed call) must not take
      // the reader down with it: the list is a picker, not a dependency.
      .then((list) => setEdgeVoices(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [listenSheet, edgeVoices.length]);

  /* ---- the neighbouring chapter's page, laid out before it is needed ---- */
  // A chapter turn only slides if there is a page to slide in, and that page has
  // to exist before the finger gets there. It is fetched while the reader sits
  // on the one page from which a chapter turn is even possible — and laid out
  // (by TurnPeek) once it arrives, off-screen, where it costs nothing to keep.
  useEffect(() => {
    // A turn is in flight: the page on the sheet is the one being dragged, and
    // the peek is part of that turn. Leave the stage alone until it is over.
    if (turnDrag) return;
    const want =
      mode === 'paged' && laidOut && !preview && !peekHandoffRef.current
        ? pageIndex + pagesPerView >= pageCount && next
          ? { cid: next.id, side: 1 as const }
          : pageIndex === 0 && prev
            ? { cid: prev.id, side: -1 as const }
            : null
        : null;
    if (!want) {
      if (peek) setPeek(null);
      return;
    }
    if (peek?.cid === want.cid && peek.side === want.side) return;
    // Nothing to drag when nothing may move.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let dead = false;
    const show = (html: string) => {
      if (!dead) setPeek({ cid: want.cid, side: want.side, html });
    };
    // A moment after the page settles: laying a whole chapter out is the same
    // work opening it does, and doing it in the frame that lands on the last
    // page would be felt as a hitch of the page that just arrived.
    const timer = window.setTimeout(() => {
      const cached = peekCache.current.get(want.cid);
      if (cached) {
        show(cached);
        return;
      }
      api
        .renderChapter(id, want.cid)
        .then((r) => {
          if (dead) return;
          const clean = DOMPurify.sanitize(r.html, CHAPTER_PURIFY);
          // Bounded: the cache exists for turning back and forth over a
          // boundary, not for keeping the book in memory.
          if (peekCache.current.size > 3) peekCache.current.clear();
          peekCache.current.set(want.cid, clean);
          show(clean);
        })
        .catch(() => {
          /* no peek: the chapter turn falls back to the dissolve */
        });
    }, 160);
    return () => {
      dead = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    laidOut,
    preview,
    current,
    pageIndex,
    pageCount,
    pagesPerView,
    next?.id,
    prev?.id,
    id,
    turnDrag,
    peek,
  ]);

  // Map each chapter document href -> Chapter, so a hierarchical TOC node can
  // resolve to the chapter id it opens.
  const byHref = useMemo(() => {
    const m = new Map<string, Chapter>();
    for (const c of chapters) m.set(c.href, c);
    return m;
  }, [chapters]);
  const resolveTocHref = (href: string): string | undefined => {
    const ch = byHref.get(docKey(href));
    return ch?.id;
  };
  // The drawer's header counts chapters, so the list has to offer all of them.
  // A nav can fail that promise in two ways:
  //
  //  * it names fewer documents than the spine holds. Converted EPUBs are the
  //    usual offenders — calibre split this book into 28 files but wrote only
  //    three labels ("Taboo", "Introduction", "Midpoint"), so the tree drew
  //    three rows under a header reading "29 章" and the other 26 chapters
  //    could not be reached from it at all;
  //  * it is flat, one row per chapter and no nesting, in which case the
  //    chapter list says the same thing and keeps the chapter numbers.
  //
  // The chapter list still wins for flat outlines. A nested outline is kept
  // even when it misses documents: the missing ones are woven back in below,
  // so the "must reach every chapter" invariant holds without flattening
  // collection epubs whose tree is otherwise perfect.
  const tocShape = useMemo(() => {
    const ids = new Set<string>();
    let nested = false;
    const walk = (es: TocEntry[]) => {
      for (const e of es) {
        if (e.href) {
          const cid = byHref.get(docKey(e.href))?.id;
          if (cid) ids.add(cid);
        }
        if (e.children?.length) {
          nested = true;
          walk(e.children);
        }
      }
    };
    walk(toc);
    return { covered: ids, nested };
  }, [toc, byHref]);
  const mergedToc = useMemo(
    () => mergeTocChapters(toc, chapters, tocShape.covered),
    [toc, chapters, tocShape],
  );
  const useTocTree = mergedToc.length > 0 && tocShape.nested;
  const currentChapter = current ? (chapters.find((c) => c.id === current) ?? null) : null;
  const activeDoc = currentChapter?.href ?? null;
  // Active highlight for the hierarchical TOC (no-op for flat-legacy books).
  const activeSet = useMemo(
    () => (activeDoc ? computeActiveHrefs(mergedToc, activeDoc) : new Set<string>()),
    [mergedToc, activeDoc],
  );

  // Expand every ancestor group of the current chapter and (after render) scroll
  // the active node into view. If no TOC surface is showing, open the drawer.
  function locateCurrent() {
    if (!activeDoc) return;
    const path = findTocPath(mergedToc, docKey(activeDoc));
    if (path.length) {
      setTocCollapsed((prev) => {
        const n = new Set(prev);
        for (const k of path) n.delete(k);
        return n;
      });
    }
    if (!tocDocked && !tocOpen) setTocOpen(true);
    setLocateNonce((n) => n + 1);
  }
  useEffect(() => {
    if (locateNonce === 0) return;
    const els = Array.from(
      document.querySelectorAll('.toc-item.active, .drawer-item.active'),
    ) as HTMLElement[];
    const el = els.find((e) => e.offsetParent !== null) || els[0];
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [locateNonce]);

  /* ---- navigation ---- */
  function openChapter(cid: string, intent: PageIntent = { type: 'first' }) {
    // A preview visit is pinned to its anchor: chapter hopping from the TOC
    // would drift through the book, and the mode exists precisely so that
    // wandering never touches the reading position. The two exits
    // (jump-to-last / start-from-here) clear the preview before calling in.
    if (previewRef.current) return;
    setPopover(null);
    if (sel) clearSelectionUI();
    setBmOpen(false);
    setTocOpen(false);
    if (intent?.type === 'restore') {
      restoreOffsetRef.current = intent.offset ?? 0;
      restoreCidRef.current = cid;
    } else if (intent?.type === 'last') {
      pageIntentRef.current = { type: 'last', cid };
    } else {
      pageIntentRef.current = { type: 'first', cid };
    }
    if (cid === current) {
      // Same chapter: setCurrent is a no-op, so force a re-measure to apply the
      // intent/restore right now (otherwise it would never be consumed).
      scheduleMeasure();
    }
    setCurrent(cid);
  }

  const turnStep = Math.max(1, pagesPerView);
  // The last spread starts at the largest page-aligned index that still has
  // content. `pageCount - pagesPerView` would force every spread to be full:
  // a 9-page chapter in two-page mode would stop at the 7/8 spread and turn
  // straight into the next chapter, and page 9 would not exist for the reader.
  // Odd page counts are the norm, not the exception, so the final spread may
  // carry a single page, alone in its slot like a book's last page.
  const maxPageIndex = Math.max(0, Math.floor((pageCount - 1) / turnStep) * turnStep);
  // The numbers a gesture turn needs while it is running. They are read from a
  // ref because the drag outlives the render that started it (a 210ms release
  // slide, a re-measure in the middle of it): the closure that runs the ending
  // may be older than the geometry it has to land on.
  const turnGeomRef = useRef({ stride: 0, step: 1, max: 0 });
  turnGeomRef.current = {
    stride: turnStep * (sheetWidth + pageGap),
    step: turnStep,
    max: maxPageIndex,
  };

  // Cross-dissolve page turn: fade the spread out, swap the page (or load the
  // next/previous chapter) while invisible, then fade back in. There is zero
  // lateral motion — a chapter change becomes a clean dissolve.
  // Used for CHAPTER turns only (different HTML not yet measured);
  // within-chapter turns swap the column strip instantly, since the whole
  // chapter is already laid out and a turn is just a translate3d.
  function startTurn(apply: () => void) {
    if (fxRef.current) return;
    fxRef.current = true;
    awaitingChapterRef.current = true;
    setFxOut(true);
    window.setTimeout(apply, 130);
  }

  // Long enough that only a badly stalled main thread can reach it; the band's
  // own animationend normally ends the turn first. The timer exists because the
  // band is display:none under prefers-reduced-motion, where no such event ever
  // arrives.
  const TURN_FX_MS = 600;

  function slideTurn(dir: 1 | -1) {
    turnFxSeq.current += 1;
    setTurnFx({ id: turnFxSeq.current, dir });
    window.clearTimeout(turnFxTimer.current);
    turnFxTimer.current = window.setTimeout(() => setTurnFx(null), TURN_FX_MS);
  }

  // Ending on the band's animation rather than on a fixed delay is what keeps
  // the turn honest: a running transition is not stopped by dropping the
  // declaration that started it — it goes on holding the specified value until
  // it is over — so a class removed on a timer would leave the page moving with
  // nothing left to tell it had finished. The timer below only covers the case
  // where the animation never runs at all (reduced motion).
  function endTurnFx() {
    window.clearTimeout(turnFxTimer.current);
    setTurnFx(null);
  }

  /* ---- a page turn the finger owns ---- */
  // The keyboard, the wheel and the page-edge clicks keep the fixed-duration
  // slide above: no finger, nothing to synchronise with. A touch gesture is the
  // opposite — the page has to be under the thumb at every instant, and where
  // the turn ends is decided by where the finger lets go.
  //
  // Both endings run through the same slide, so a release never "resolves" a
  // turn the reader has not already been shown: drag a third of the page, let
  // go, and the page finishes the journey from exactly where it was left.
  const TURN_SLIDE_MS = 210; // must match .reader-spread.turn-settle in styles.css

  // The page's position during a turn, in px from the spread it belongs to.
  // Written straight to the element: this runs on every touchmove.
  //
  // `cancelSlide` is the take-over case. A running CSS transition keeps winning
  // over the specified value until it is over — dropping the class that declared
  // it does not stop it, and neither does writing a new value (Chrome carries on
  // to the old target). The only way to stop it where it stands is to take the
  // transition out of the style and force a recalc before the value goes in;
  // that recalc is never painted, so the jump it causes is not seen.
  function placeDrag(px: number, cancelSlide = false) {
    const el = dragLayerRef.current;
    if (!el) return;
    if (cancelSlide) {
      el.style.transition = 'none';
      void el.offsetWidth;
    }
    el.style.transform = px === 0 ? '' : `translate3d(${px}px, 0, 0)`;
  }

  // Where the page is right now. Only read when a new touch catches a page that
  // is still sliding.
  function dragLayerX(): number {
    const el = dragLayerRef.current;
    if (!el) return 0;
    const tr = getComputedStyle(el).transform;
    if (!tr || tr === 'none') return 0;
    const m = tr.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!m) return 0;
    const v = m[1].split(',').map(Number);
    return tr.startsWith('matrix3d') ? v[12] : v[4];
  }

  // The shadow rides the same progress as the page: off the right edge before
  // the turn, off the left edge after it — so at any point of a drag it sits
  // where the pulled page's edge is, instead of flying on its own schedule.
  //
  // The band's width is measured ONCE per veil: reading offsetWidth here would
  // force a layout on every touchmove, which is exactly the cost a page turn
  // must not pay. The veil is keyed per turn, so a new turn re-measures.
  function placeBand(p: number, dir: 1 | -1) {
    const band = veilRef.current?.firstElementChild as HTMLElement | null;
    if (!band) return;
    const w = viewWidth;
    const cache = bandGeomRef.current;
    if (!cache || cache.el !== band || cache.w !== w) {
      bandGeomRef.current = { el: band, w, bw: band.offsetWidth };
    }
    const bw = bandGeomRef.current!.bw;
    const travel = w + bw;
    band.style.transform = `translate3d(${dir > 0 ? w - p * travel : p * travel - bw}px, 0, 0)`;
  }

  // The neighbour's page rides the same offset as the page leaving: one spread
  // away at rest, home at a full stride. `px` is the live page's offset, so the
  // two move as one gesture.
  function placePeek(px: number, dir: 1 | -1) {
    const el = peekRef.current;
    if (!el) return;
    const { stride } = turnGeomRef.current;
    el.style.transform = `translate3d(${(dir > 0 ? stride : -stride) + px}px, 0, 0)`;
  }

  function dragAvailable(dir: 1 | -1) {
    const { step, max } = turnGeomRef.current;
    return dir > 0 ? pageIndex + step <= max : pageIndex - step >= 0;
  }

  // Is there a page to turn to past this chapter's edge? Only when the
  // neighbour's page is already laid out in the peek: without it there would be
  // nothing to drag in, and the cross-fade covers the load instead.
  function chapterReachable(dir: 1 | -1) {
    if (mode !== 'paged' || previewRef.current) return false;
    const p = peekLive.current;
    if (peekHandoffRef.current || !p || p.side !== dir) return false;
    return dir > 0 ? !!next : !!prev;
  }

  // Returns whether the page took the gesture. A chapter edge takes it too, as
  // long as the neighbour's page is ready: the peek is positioned exactly one
  // spread away, so the same drag brings it in.
  function beginDragTurn(dx: number): boolean {
    if (previewRef.current) return false;
    if (peekHandoffRef.current) return false;
    // A chapter turn is a one-way journey with the next chapter loading behind
    // the peek; there is nothing to catch and re-aim, so it refuses a new grip.
    if (dragTurnRef.current?.kind === 'chapter') return false;
    // Reduced motion is a request for no moving pictures, and a page sliding
    // under the thumb is exactly that.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    // A fast reader flicks again before the last page has finished sliding. The
    // new touch catches the page where it is and drags on from there, instead
    // of fighting the slide or waiting it out.
    const carried = dragTurnRef.current?.settling ? dragLayerX() : 0;
    const px = carried + dx;
    const dir: 1 | -1 = px < 0 ? 1 : -1;
    const kind: 'page' | 'chapter' = dragAvailable(dir) ? 'page' : 'chapter';
    if (kind === 'chapter' && !chapterReachable(dir)) return false;
    if (carried) {
      window.clearTimeout(dragEndTimer.current);
      dragTurnRef.current!.settling = false;
      dragTurnRef.current!.commit = false;
      // Pin the page where it was caught, before the class change reaches React.
      placeDrag(carried, true);
    }
    dragTurnRef.current = { dir, px, origin: carried, commit: false, settling: false, kind };
    setTurnDrag({ dir, phase: 'follow' });
    followDrag(dx);
    return true;
  }

  // 1:1 with the finger, but never past the neighbouring spread: the strip
  // holds the whole chapter, so beyond that it would show the end of the paper
  // rather than more book. There it stiffens instead.
  function followDrag(dx: number) {
    const d = dragTurnRef.current;
    if (!d) return;
    const stride = turnGeomRef.current.stride || 1;
    // Measured from where this finger started, which is the page's own position
    // on a fresh drag and wherever it was caught on one that interrupts a slide.
    let px = d.origin + dx;
    // The reader drags a page back and forth before deciding, so the direction
    // is whatever side of the spread the finger is on now.
    const want: 1 | -1 = px < 0 ? 1 : -1;
    if (want !== d.dir) {
      // A chapter turn has only its one neighbour waiting behind the spread, so
      // it cannot reverse into that chapter. It can, however, hand the gesture
      // back to the strip: the finger changed its mind and is now pulling a page
      // of this chapter, and the neighbour's page simply goes home.
      if (!dragAvailable(want)) {
        d.px = 0;
        placeDrag(0);
        placeBand(0, d.dir);
        if (d.kind === 'chapter') placePeek(0, d.dir);
        return;
      }
      if (d.kind === 'chapter') {
        placePeek(0, d.dir);
        d.kind = 'page';
      }
      d.dir = want;
    }
    const mag = Math.abs(px);
    px = mag <= stride ? mag : stride + (mag - stride) * 0.12;
    d.px = -want * px;
    placeDrag(d.px);
    placeBand(Math.min(1, px / stride), d.dir);
    if (d.kind === 'chapter') placePeek(d.px, d.dir);
  }

  // Let go. A flick counts even when it barely moved the page — the gesture
  // said "next" — and a slow drag has to be carried the distance the reader's
  // 翻页灵敏度 setting asks for (标准 = a third of the spread, the value this
  // reader has always used).
  // `interrupted` is the system taking the gesture back: nobody let go, so
  // nothing was decided, and the page returns whatever it had travelled.
  function releaseDragTurn(flick: number, interrupted = false) {
    const d = dragTurnRef.current;
    if (!d) return;
    // Already decided: a settle in flight is not re-judged by a later touch,
    // and a chapter turn is waiting for its chapter, not for another verdict.
    if (d.settling) return;
    const dist = Math.abs(d.px);
    const { far, flickFloor } = turnThresholds(turnSensRef.current, turnGeomRef.current.stride);
    d.commit = !interrupted && (dist >= far || (flick * d.dir < -0.5 && dist > flickFloor));
    // The card points at a word on the page being left behind. It goes when the
    // page is known to be going — not at touchstart, where unmounting the
    // element under the finger makes the browser cancel the gesture — and not
    // when the page is only being pulled at and let go again.
    if (d.commit) {
      cancelWordLookup();
      setLookupCard(null);
    }
    d.settling = true;
    setTurnDrag({ dir: d.dir, phase: 'settle' });
    window.clearTimeout(dragEndTimer.current);
    // Only a stalled main thread reaches this: the slide's own transitionend
    // normally ends the turn first.
    dragEndTimer.current = window.setTimeout(finishDragTurn, TURN_SLIDE_MS + 240);
  }

  function finishDragTurn() {
    window.clearTimeout(dragEndTimer.current);
    const d = dragTurnRef.current;
    if (d?.commit && d.kind === 'chapter') {
      const target = d.dir > 0 ? next : prev;
      if (target) {
        // Everything stays exactly where the slide left it: the peek covers the
        // page while the chapter loads, and measureAndLayout drops the offset in
        // one frame once the new page is painted underneath (see the handoff).
        peekHandoffRef.current = true;
        openChapter(target.id, { type: d.dir > 0 ? 'first' : 'last' });
        return;
      }
    }
    dragTurnRef.current = null;
    if (d?.commit) {
      // The strip's base moves to the page the slide ended on, and the drag
      // offset is dropped in the same commit — see the layout effect below.
      const { step, max } = turnGeomRef.current;
      setPageIndex((p) => Math.max(0, Math.min(max, p + d.dir * step)));
    } else {
      placeDrag(0);
    }
    setTurnDrag(null);
  }

  // The release target is written after React has put the settling class on the
  // element: the transition must exist before the value it has to animate.
  // During the drag this only places the band — and re-anchors a page that a
  // new touch has just caught, in the same frame the transition comes off, so
  // it stops where it was instead of snapping to the value it was heading for.
  useLayoutEffect(() => {
    const d = dragTurnRef.current;
    if (!turnDrag || !d) return;
    const stride = turnGeomRef.current.stride || 1;
    if (turnDrag.phase === 'settle') {
      // A page that was caught by hand has an inline `transition: none` on it
      // from the take-over; this is where it goes back to the stylesheet's.
      const el = dragLayerRef.current;
      if (el) el.style.transition = '';
      placeDrag(d.commit ? -d.dir * stride : 0);
      placeBand(d.commit ? 1 : 0, d.dir);
      if (d.kind === 'chapter') placePeek(d.commit ? -d.dir * stride : 0, d.dir);
    } else {
      placeDrag(d.px);
      placeBand(Math.min(1, Math.abs(d.px) / stride), d.dir);
      if (d.kind === 'chapter') placePeek(d.px, d.dir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnDrag]);

  // A committed turn: the base has just moved to the new page, so the offset
  // goes now — one frame later and the same page would be shown twice.
  useLayoutEffect(() => {
    if (dragTurnRef.current) return;
    placeDrag(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  // A chapter turn with no finger on it — the keyboard, the wheel, a click on
  // the page edge — plays the same slide as a gesture one whenever the
  // neighbour's page is already laid out. Two frames, for the same reason a
  // release needs them: the band has to be put at its start without a
  // transition before the transition may carry it across.
  function slideChapterTurn(dir: 1 | -1): boolean {
    if (!chapterReachable(dir)) return false;
    dragTurnRef.current = {
      dir,
      px: 0,
      origin: 0,
      commit: true,
      settling: true,
      kind: 'chapter',
    };
    setTurnDrag({ dir, phase: 'follow' });
    requestAnimationFrame(() => {
      const d = dragTurnRef.current;
      if (!d || d.kind !== 'chapter') return;
      setTurnDrag({ dir, phase: 'settle' });
      window.clearTimeout(dragEndTimer.current);
      // Only a stalled main thread reaches this; the drag layer's own
      // transitionend normally ends the slide first.
      dragEndTimer.current = window.setTimeout(finishDragTurn, TURN_SLIDE_MS + 240);
    });
    return true;
  }

  function turn(delta: number) {
    // Preview visits do not turn pages: the position must stay on the anchor,
    // and every save guard aside, drifting would break the "temporary look"
    // model. Use the banner's two exits to leave the mode.
    if (previewRef.current) return;
    // A chapter turn is already in flight, with its chapter loading behind the
    // peek: another turn would have nowhere to land.
    if (peekHandoffRef.current) return;
    // The card points at a word on the page being left behind.
    cancelWordLookup();
    setLookupCard(null);
    if (sel) clearSelectionUI();
    const step = turnStep;
    if (delta > 0) {
      if (pageIndex + step <= maxPageIndex) {
        slideTurn(1);
        setPageIndex(pageIndex + step);
      } else if (next) {
        if (!slideChapterTurn(1)) startTurn(() => openChapter(next.id, { type: 'first' }));
      }
    } else {
      if (pageIndex - step >= 0) {
        slideTurn(-1);
        setPageIndex(pageIndex - step);
      } else if (prev) {
        if (!slideChapterTurn(-1)) startTurn(() => openChapter(prev.id, { type: 'last' }));
      }
    }
  }

  /* keep the current view inside the book when switching 1<->2 page mode */
  useEffect(() => {
    if (mode !== 'paged') return;
    if (pageIndex > maxPageIndex) setPageIndex(maxPageIndex);
  }, [mode, pageCount, pagesPerView]);

  // Which page-turn zone a viewport x sits in: -1 the covered pages to the left
  // of the book, 0 the page itself, 1 the covered pages to the right.
  //
  // The zones are measured from the BOOK, not from the window: on a wide screen
  // all the empty space flanking the book still turns pages, and on any screen
  // the book's own outer margin does too — that margin is the "stack of paper"
  // the reader aims at. A proportional share of the window (18% each side) used
  // to turn pages from inside the text column on small windows, which is where
  // words are.
  function turnZoneAt(clientX: number): -1 | 0 | 1 {
    const spread = spreadRef.current;
    if (!spread) return 0;
    const r = spread.getBoundingClientRect();
    if (r.width <= 0) return 0;
    // On touch the margin is only ~22px, so the band must stay well inside it —
    // otherwise tapping the first character of a line turns the page instead of
    // opening the dictionary card, which is the more common intent by far.
    const band = touchPrimary ? 14 : Math.min(marginPx, 26);
    if (clientX < r.left + band) return -1;
    if (clientX > r.right - band) return 1;
    return 0;
  }

  function onStageClick(e: ReactMouseEvent) {
    // Ignore clicks on interactive content and active text selections.
    const target = e.target as HTMLElement;
    if (
      target.closest('a') ||
      target.closest('button') ||
      target.closest('mark.hl') ||
      target.closest('input') ||
      target.closest('textarea')
    ) {
      return;
    }
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) return;

    // A drag along the page edge already turned; the click on mouseup must not
    // turn again.
    if (Date.now() - turnedAtRef.current < 300) return;

    // Touch division of labour (微信读书/番茄 school):
    //   0. a tap while the dictionary card is open dismisses the card; a tap
    //      inside the card belongs to the card;
    //   1. otherwise a tap on a word looks it up — wherever the word is;
    //   2. every remaining tap toggles the chrome. Taps never turn pages on
    //      touch: the thirds split meant a slightly mis-aimed tap skipped a
    //      page, so a turn is a horizontal swipe and nothing else.
    if (touchPrimary) {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (lookupCard) {
        if (!el?.closest('.dict-card')) setLookupCard(null);
        return;
      }
      if (scheduleWordLookup(e.clientX, e.clientY)) return;
      setChromeOpen((o) => !o);
      return;
    }

    // Desktop: the paper's own outer margin is a page-turn surface (and the
    // drag-to-turn gesture targets), then word lookup, then the narrow middle
    // band toggles the chrome.
    const zone = turnZoneAt(e.clientX);
    if (zone < 0) {
      turn(-1);
      return;
    }
    if (zone > 0) {
      turn(1);
      return;
    }

    if (scheduleWordLookup(e.clientX, e.clientY)) return;

    const stage = stageRef.current;
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;

    // The narrow middle band toggles the chrome. Everything else in the page is
    // left to text selection and links.
    if (ratio > 0.42 && ratio < 0.58) setChromeOpen((o) => !o);
  }

  /* ---- drag along the page edge to turn ---- */
  // Pressing in a page-turn zone and pulling the paper sideways turns a page:
  // pulling left walks forward through the book, pulling right walks back. One
  // turn per gesture, so a long drag cannot skip a dozen pages.
  const DRAG_TURN_PX = 44;

  function onStageMouseDown(e: ReactMouseEvent) {
    dragRef.current = null;
    if (e.button !== 0) return;
    if (turnZoneAt(e.clientX) === 0) return;
    // The margin is a page-turn surface, so a press there must not start
    // smearing a text selection across the page.
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY, fired: false };
  }

  function onStageMouseMove(e: ReactMouseEvent) {
    const d = dragRef.current;
    if (!d || d.fired || e.buttons !== 1) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // Horizontal intent only: a vertical drag along the edge is a slip, not a
    // page turn.
    if (Math.abs(dx) < DRAG_TURN_PX || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    d.fired = true;
    turnedAtRef.current = Date.now();
    turn(dx < 0 ? 1 : -1);
  }

  function onStageMouseUp() {
    dragRef.current = null;
  }

  /* ---- mouse wheel page turning ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
    const stage = stageRef.current;
    if (!stage) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - last < 180) return;
      last = now;
      if (e.deltaY > 0) turn(1);
      else if (e.deltaY < 0) turn(-1);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [mode, pageIndex, pageCount, pagesPerView, prev, next]);

  // Routes one tap (touch, after the reader claimed the gesture) to its
  // meaning. Same division of labour as onStageClick's touch branch, but it
  // works on raw coordinates: the native click event never fires for a touch
  // this reader has prevented.
  function routeTap(x: number, y: number) {
    if (Date.now() - turnedAtRef.current < 300) return;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    // The dictionary card is a floating layer over the text: a tap outside it
    // dismisses it, a tap inside it belongs to the card (its buttons get real
    // clicks; blank spots must neither look up the text beneath nor toggle the
    // chrome).
    if (lookupCard) {
      if (!el?.closest('.dict-card')) setLookupCard(null);
      return;
    }
    // A tap on a highlight opens its annotation popover — the mark check the
    // click path used to do, re-expressed as a hit test.
    const mark = el?.closest('mark.hl') as HTMLElement | null;
    if (mark && mark.dataset.annId && mark.dataset.annId !== ANCHOR_ID) {
      const ann = annotations.find((a) => a.id === mark.dataset.annId);
      if (ann) {
        const r = mark.getBoundingClientRect();
        setNoteDraft(ann.note);
        setPopover({ x: r.left + r.width / 2, y: r.bottom + 8, ann });
      }
      return;
    }
    if (scheduleWordLookup(x, y)) return;
    // Taps never turn pages on touch — a page turn is a horizontal swipe.
    // Everything that is not a word lookup toggles the chrome, which is also
    // how the edge menus come and go.
    setChromeOpen((o) => !o);
  }
  const routeTapRef = useRef(routeTap);
  routeTapRef.current = routeTap;

  /* ---- touch: a horizontal swipe turns the page ---- */
  // Registered as native listeners so touchmove can be non-passive and own the
  // gesture: without that the WebView treats a fast horizontal drag as its own
  // overscroll/back gesture and the page never sees the move events. CSS
  // (`touch-action: pan-y` on the paged stage) keeps the browser out of the way.
  //
  // The reader OWNS the page gesture end to end: touchstart is prevented, so
  // the browser never starts its own long-press selection, never shows its
  // floating text menu (the "圆形菜单" the notebook jump used to surface) and
  // never synthesises a click that would race our routing. Every meaning —
  // tap, swipe, hold — is decided here.
  useEffect(() => {
    if (mode !== 'paged') return;
    // Listen on the whole reader, not just the stage: the word card and the
    // chrome bars are siblings of the stage, so a touch that starts on one of
    // them never bubbles to a stage listener and the swipe is silently dropped.
    // Looking a word up and then turning the page is the most common sequence
    // in this reader, and the card sits exactly where the thumb already is.
    const host = readerRef.current;
    if (!host) return;
    // The swipe floor for the paths that never hand the page to the finger —
    // preview mode, and reduced motion (a page sliding under the thumb is
    // exactly what that setting asks not to see). Everything else decides on
    // the drag itself, in releaseDragTurn. 40 px is the 标准 level; the others
    // scale it so the setting is not silently ignored just because the reader
    // prefers reduced motion.
    const MIN_TRAVEL = 40; // px before a drag counts as a page turn
    const MIN_RATIO = 1.2; // horizontal travel must beat vertical by this much
    const LP_MS = 450; // hold-to-select threshold, tuned like 微信读书
    const LP_SLOP = 10; // finger drift that cancels the hold
    const TAP_MS = 500; // holds longer than this are a press, not a tap
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let active = false;
    let horizontal = false;
    let lpTimer = 0;
    // Set only when the hold actually produced a selection, so a held press on
    // blank paper still counts as a (chrome-toggling) tap on release.
    let lpFired = false;
    // Recent finger positions of the current drag, for the release decision: a
    // flick has to count even when it barely moved the page, and one frame of
    // velocity is noise.
    const samples: Array<{ x: number; t: number }> = [];

    const flickVelocity = (): number => {
      const now = Date.now();
      const recent = samples.filter((s) => now - s.t < 120);
      if (recent.length < 2) return 0;
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = b.t - a.t;
      return dt > 0 ? (b.x - a.x) / dt : 0;
    };

    const cancelLongPress = () => {
      window.clearTimeout(lpTimer);
      lpTimer = 0;
    };

    // Surfaces that keep native behaviour — their buttons, sliders and inputs
    // need real click events, and a drag inside them must never turn pages.
    // The floating cards are deliberately NOT listed: everything interactive
    // inside them is a button/input (matched below), and a swipe that starts
    // on the word card must still turn the page. The AI surfaces ARE listed:
    // a bottom panel scrolled with a thumb, or a privacy dialog being read,
    // has nothing to do with page turning.
    const isNativeTarget = (t: EventTarget | null): boolean =>
      !!(
        t instanceof Element &&
        (t.closest('.drawer-mask') ||
          t.closest('.sheet-mask') ||
          t.closest('.ai-sheet') ||
          t.closest('.modal-backdrop') ||
          t.closest('.reader-chrome') ||
          t.closest('.sel-handle') ||
          t.closest('button') ||
          t.closest('input') ||
          t.closest('textarea') ||
          t.closest('a'))
      );

    const onStart = (e: TouchEvent) => {
      lpFired = false;
      samples.length = 0;
      // Multi-touch is never a page turn (pinch, or a stray second finger).
      if (e.touches.length !== 1) {
        active = false;
        return;
      }
      const target = e.target as HTMLElement | null;
      if (isNativeTarget(target)) {
        active = false;
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startT = Date.now();
      active = true;
      horizontal = false;
      // Owning the gesture: no native long-press selection, no synthesized
      // click, no native text handles. Everything below is ours.
      if (e.cancelable) e.preventDefault();
      // The card points at a word on the page being left behind.
      cancelWordLookup();
      // A new touch on the page ends the previous word selection (dragging a
      // handle or tapping the toolbar is exempt — see the ignore list above).
      selLockRef.current = false;
      contentRef.current?.classList.remove('allow-sel');
      const s = window.getSelection();
      if (s && !s.isCollapsed) s.removeAllRanges();
      // Own the long-press: native selection inside the column layout selects
      // the whole content box (the "整面变暗" bug), so user-select is disabled
      // and this timer builds a one-word selection instead.
      cancelLongPress();
      lpTimer = window.setTimeout(() => {
        lpTimer = 0;
        if (!active) return;
        // allowCJK: a hold on Chinese text selects that one character (a tap
        // must not — there is no Chinese dictionary to open).
        const hit = wordHitAt(startX, startY, true);
        if (!hit) return;
        // A tap on the word would have been a lookup; a hold is a selection.
        try {
          navigator.vibrate?.(15);
        } catch {
          /* no vibration on this device */
        }
        lpFired = true;
        setLookupCard(null);
        // Blink refuses selections inside user-select:none subtrees, so the
        // word selection needs the flag on for its whole lifetime (until the
        // next touchstart, above).
        contentRef.current?.classList.add('allow-sel');
        selLockRef.current = true;
        selRangeRef.current = hit.range;
        const s = window.getSelection();
        if (s) {
          s.removeAllRanges();
          s.addRange(hit.range);
        }
        applySelRange(hit.range);
        // Swallow the tap that ends the gesture: with a live selection it
        // would be a no-op anyway, but turning the timestamp also protects the
        // no-hit case.
        turnedAtRef.current = Date.now();
      }, LP_MS);
    };

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.hypot(dx, dy) > LP_SLOP) cancelLongPress();
      // A page already in this finger's hand follows it whatever it does next —
      // it is off its mark, and freezing it mid-drag reads as a dropped gesture.
      // A page still sliding home from the last flick is NOT in this hand yet:
      // it is caught below, once this gesture has travelled far enough to be one.
      const held = dragTurnRef.current;
      if (held && !held.settling) {
        if (e.cancelable) e.preventDefault();
        samples.push({ x: t.clientX, t: Date.now() });
        if (samples.length > 8) samples.shift();
        followDrag(dx);
        return;
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        horizontal = true;
        if (e.cancelable) e.preventDefault();
        // From the first horizontal pixel the page belongs to the finger: it
        // sits exactly where the drag has taken it, so the gesture is answered
        // while it happens rather than after it has been judged.
        samples.push({ x: t.clientX, t: Date.now() });
        if (samples.length > 8) samples.shift();
        beginDragTurn(dx);
      }
    };

    const onEnd = (e: TouchEvent) => {
      cancelLongPress();
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      if (!t) {
        if (dragTurnRef.current) releaseDragTurn(0);
        return;
      }
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!horizontal) {
        // A tap: the native click was suppressed at touchstart, so route it
        // ourselves. A hold that produced a selection is not a tap.
        if (!lpFired && Date.now() - startT < TAP_MS) routeTapRef.current(t.clientX, t.clientY);
        return;
      }
      // Dismiss whatever floats over the page only once the gesture is over.
      // Unmounting the element under the finger mid-drag makes the browser
      // cancel the touch sequence, and the page turn never happens — which is
      // how "swipe while the word card is open" stayed broken even after the
      // listener moved to the reader root.
      const dismiss = () => {
        setSel(null);
        setPopover(null);
        setChromeOpen(false);
      };
      // A page that was pulled in owns the release however far it went: it has
      // to be put down somewhere, finished or returned.
      if (dragTurnRef.current) {
        turnedAtRef.current = Date.now();
        dismiss();
        releaseDragTurn(flickVelocity());
        return;
      }
      if (Math.abs(dx) < MIN_TRAVEL * turnLevelFactor(turnSensRef.current)) return;
      if (Math.abs(dx) < Math.abs(dy) * MIN_RATIO) return;
      // The gesture was ours end to end; no stray click can follow.
      turnedAtRef.current = Date.now();
      dismiss();
      turn(dx < 0 ? 1 : -1);
    };

    const onCancel = () => {
      cancelLongPress();
      active = false;
      horizontal = false;
      // The system took the gesture back (a notification shade pulled down, an
      // app switch): nobody let go, so the page must not be left standing half
      // turned — and must not be turned on a decision no finger made. A page
      // still sliding from an earlier flick is not this gesture's to interrupt.
      const held = dragTurnRef.current;
      if (held && !held.settling) releaseDragTurn(0, true);
    };

    host.addEventListener('touchstart', onStart, { passive: false });
    host.addEventListener('touchmove', onMove, { passive: false });
    host.addEventListener('touchend', onEnd, { passive: true });
    host.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      cancelLongPress();
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onCancel);
      // A re-registration (page change, mode switch, rotation) mid-gesture
      // orphans the drag: put the page back rather than leave it half turned.
      // Not while a chapter turn is handing over, though — that drag is the
      // chapter load's, and the handoff drops it when the new page is painted.
      if (dragTurnRef.current && !peekHandoffRef.current) {
        dragTurnRef.current = null;
        window.clearTimeout(dragEndTimer.current);
        // No transition here: the offset is being abandoned, not settled, and a
        // slide running on while the sheet changes under it would be seen.
        placeDrag(0, true);
        setTurnDrag(null);
      }
    };
  }, [mode, pageIndex, pageCount, pagesPerView, prev, next]);

  /* ---- detour (opened from the notebook) ---- */
  // Ends the preview and switches to normal reading. Every exit below calls
  // this FIRST: it clears both the state and the gesture guard ref, so the
  // openChapter / turn calls that follow are no longer blocked.
  function endPreview() {
    previewRef.current = null;
    setPreview(null);
    // The visit's anchor mark has served its purpose; unwrap it so normal
    // reading shows plain text again.
    const root = contentRef.current;
    if (root) {
      root.querySelectorAll('mark.hl-vocab').forEach((m) => {
        const frag = document.createDocumentFragment();
        while (m.firstChild) frag.appendChild(m.firstChild);
        m.replaceWith(frag);
      });
    }
  }

  /* ---- preview (opened from 生词本 / 划线 / 书签) ---- */
  // Adopts the preview position as the reading position. Deliberately explicit:
  // it is the only way a jumped-in visit is allowed to overwrite progress.
  function resumeFromPreview() {
    endPreview();
    if (!current) return;
    const off = mode === 'paged' ? offsetForPage(pageIndex) : offsetAtViewportTop();
    api.saveProgress(id, current, off, mode === 'paged' ? pageCount : 1).catch(() => {});
    // This is ordinary reading now: rewrite the history entry without the
    // preview payload so back/refresh cannot resurrect the visit.
    nav(`/books/${id}/read/${current}`, { replace: true });
    toast('已从当前位置开始阅读', 'success');
  }

  // Jumps to where the reader actually was. The preview ends here: they are
  // standing on their own reading position again, so saving progress from now
  // on records the same place rather than a place they never chose.
  function jumpToLastReading() {
    if (!origin || !origin.chapterId) return;
    endPreview();
    // Same rewrite: the visit ended, the entry is plain reading again.
    nav(`/books/${id}/read/${origin.chapterId}`, { replace: true });
    if (origin.chapterId !== current) {
      openChapter(origin.chapterId, { type: 'restore', offset: origin.positionOffset });
      return;
    }
    if (mode === 'paged') {
      restoreOffsetRef.current = origin.positionOffset;
      restoreCidRef.current = current; // same chapter, but stamp it anyway
      scheduleMeasure();
      return;
    }
    const box = scrollTextTo(origin.positionOffset);
    if (box) flashAt(box);
  }

  /* ---- keyboard ---- */
  // One level up the operation hierarchy: the page the reader came from.
  // replace only when there is nothing to pop (direct load / refresh) — a
  // deliberate exit must never be resurrectable by the back button.
  function goUp(fallback: string) {
    const st = window.history.state as { idx?: number } | null;
    const idx = st && typeof st.idx === 'number' ? st.idx : 0;
    // An open overlay must not turn this button into a no-op: the pop would be
    // swallowed by the overlay guard and the reader would stay on screen, which
    // reads as a dead button. Close the overlays and step over them as well, so
    // one press still means one level.
    //
    // Capped at what actually exists: `idx` counts the entries ABOVE the root,
    // so this page plus everything behind it is idx+1, and asking for more is a
    // silent no-op that leaves the button looking dead.
    const depth = Math.min(navigationDepth(), idx + 1);
    closeForNavigation();
    if (idx > 0) nav(-depth);
    else nav(fallback, { replace: true });
  }

  function exitReading() {
    // Leaving a preview returns to the page that opened it and leaves the
    // reading position alone — that is the whole point of the visit.
    if (previewRef.current) {
      goUp(PREVIEW_SOURCE[previewRef.current.source].back);
      return;
    }
    // Persist current position before leaving so progress isn't lost.
    if (current) {
      // Scrolling has no page index, so the anchor has to come from the text at
      // the top of the pane — writing 0 here is what made "last read" always
      // mean "start of the chapter".
      const off = mode === 'paged' ? offsetForPage(pageIndex) : offsetAtViewportTop();
      const total = mode === 'paged' ? pageCount : 1;
      api.saveProgress(id, current, off, total).catch(() => {});
    }
    goUp('/');
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

      // Escape peels one layer at a time: whatever is floating over the page
      // goes first, and only a reader with nothing left to dismiss leaves the
      // book. Otherwise Escape would silently close the book while a word card
      // or the menu bar was open — exactly the press someone makes to get rid
      // of the overlay.
      if (e.key === 'Escape') {
        // Overlays are checked innermost first.
        if (lookupCard) {
          setLookupCard(null);
          return;
        }
        if (popover) {
          setPopover(null);
          return;
        }
        if (sel) {
          clearSelectionUI();
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (tocOpen) {
          setTocOpen(false);
          return;
        }
        if (bmOpen) {
          setBmOpen(false);
          return;
        }
        if (annOpen) {
          setAnnOpen(false);
          return;
        }
        // A bar raised by hovering the edge is not state anyone chose, but it
        // is still on screen. Both ways of showing it count as one layer: the
        // pointer is usually resting in the edge band when the bars are open,
        // so dismissing only `chromeOpen` would leave the bar up and cost a
        // second press. The hover probe stays muted until the pointer leaves
        // the band, which keeps this from turning into a fight with mousemove.
        if (chromeOpen || chromeHover) {
          setChromeOpen(false);
          if (chromeHover) {
            hoverDismissedRef.current = true;
            setChromeHover(false);
          }
          return;
        }
        // Typing somewhere (a note) must not throw the reader out of the book.
        if (inField) {
          (e.target as HTMLElement).blur();
          return;
        }
        exitReading();
        return;
      }

      if (inField) return;

      // Backspace exits the reader.
      if (e.key === 'Backspace') {
        e.preventDefault();
        exitReading();
        return;
      }

      // Enter shows the menu bar / chrome.
      if (e.key === 'Enter') {
        e.preventDefault();
        setChromeOpen(true);
        return;
      }

      if (mode === 'paged') {
        if (e.key === 'ArrowLeft') turn(-1);
        if (e.key === 'ArrowRight') turn(1);
        // Space turns the page forward; Shift+Space turns back. Prevent the
        // default page-scroll that Space would otherwise trigger.
        if (e.code === 'Space') {
          e.preventDefault();
          turn(e.shiftKey ? -1 : 1);
        }
      } else {
        if (e.key === 'ArrowLeft' && prev) setCurrent(prev.id);
        if (e.key === 'ArrowRight' && next) setCurrent(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    mode,
    prev,
    next,
    pageIndex,
    pageCount,
    chromeOpen,
    chromeHover,
    popover,
    sel,
    bmOpen,
    annOpen,
    tocOpen,
    settingsOpen,
    lookupCard,
    current,
    id,
    preview,
  ]);

  /* ---- hover the top/bottom edge to reveal the reader chrome (paged) ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
    // During a preview visit the banner floats along the bottom edge, and a
    // chrome bar sliding out under the pointer would cover the very buttons the
    // reader is reaching for. The bars stay reachable: Enter, or a click in the
    // middle of the page.
    if (preview) {
      setChromeHover(false);
      return;
    }
    const EDGE = CHROME_EDGE; // band that activates (hover) or toggles (tap) the chrome
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf) return; // coalesce bursts of mousemove into one frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = e.clientY;
        const h = window.innerHeight;
        const near = y < EDGE || y > h - EDGE;
        // Leaving the band re-arms the probe, so a dismissed bar comes back
        // when the pointer returns to the edge later on.
        if (!near) hoverDismissedRef.current = false;
        if (near && hoverDismissedRef.current) {
          setChromeHover(false);
          return;
        }
        // Functional update avoids stale closures and only re-renders on change.
        setChromeHover((prev) => (prev === near ? prev : near));
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (raf) cancelAnimationFrame(raf);
      setChromeHover(false);
    };
  }, [mode, preview]);

  /* ---- selection -> toolbar (both modes) ---- */

  // One place to tear the selection UI down: DOM selection, the locked-range
  // bookkeeping and the selectable flag all go together. Callers that only
  // swap `sel` for another state (lookup, annotation) clear the lock too —
  // a stale lock would resurrect the dead range on the next selectionchange.
  function clearSelectionUI() {
    setSel(null);
    selLockRef.current = false;
    selRangeRef.current = null;
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* nothing selected */
    }
    contentRef.current?.classList.remove('allow-sel');
  }

  // Reads whatever the browser currently has selected into the popover state.
  //
  // It has two triggers on purpose. A mouse delivers `mouseup`, but a long press
  // on a phone produces a selection and never a mouseup at all — which is why
  // the toolbar used to be unreachable on touch. The selection itself is the
  // signal, not the gesture that made it.
  function syncSelectionFromDom() {
    const root = contentRef.current;
    if (!root) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      // A locked selection must survive Blink's transient "empty" reports at
      // gesture boundaries: re-assert the range we know is live instead of
      // tearing the toolbar down. This is what kept the menu from vanishing
      // the moment a drag handle was released.
      const locked = selRangeRef.current;
      if (selLockRef.current && locked && !locked.collapsed) {
        try {
          selection?.removeAllRanges();
          selection?.addRange(locked);
        } catch {
          /* the range died with a re-render; fall through to dismissal */
        }
        applySelRange(locked);
        return;
      }
      setSel(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setSel(null);
      return;
    }
    const offs = getSelectionOffsets(root, range);
    if (!offs) {
      setSel(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const rects = selectionEndRects(range);
    selRangeRef.current = range;
    setSel({
      x: rect.left + rect.width / 2,
      y: rect.top,
      bottom: rect.bottom,
      start: offs.start,
      end: offs.end,
      // `text` is TEXT from here on — it becomes a highlight's label, an AI
      // prompt, a notebook context — so the invisible marks a print conversion
      // left inside words are dropped at this boundary, exactly like the ones
      // the sentence and lookup paths already drop. The offsets keep counting
      // the characters that are really in the document.
      text: stripInvisible(selection.toString()),
      firstRect: rects ? snapRect(rects.first) : undefined,
      lastRect: rects ? snapRect(rects.last) : undefined,
    });
  }

  // Re-applies a reshaped range: into the DOM selection (so the highlight
  // follows the thumb) and into `sel` (so the handles and toolbar reposition).
  function applySelRange(range: Range) {
    const root = contentRef.current;
    if (!root) return;
    const offs = getSelectionOffsets(root, range);
    if (!offs || offs.end <= offs.start) return;
    const rects = selectionEndRects(range);
    if (!rects) return;
    selRangeRef.current = range;
    setSel({
      x: (rects.first.left + rects.last.right) / 2,
      y: rects.first.top,
      bottom: rects.last.bottom,
      start: offs.start,
      end: offs.end,
      // Same boundary rule as syncSelectionFromDom: a reshaped selection is
      // still text leaving the reader.
      text: stripInvisible(range.toString()),
      firstRect: snapRect(rects.first),
      lastRect: snapRect(rects.last),
    });
  }

  // Dragging a handle reshapes the selection: the touched point (mapped back
  // up onto the text line) becomes the new start/end caret, the opposite end
  // stays pinned. The DOM selection is rebuilt on every frame so the native
  // highlight tracks the handles, and the toolbar only returns on release.
  function startHandleDrag(e: React.TouchEvent, which: 'start' | 'end') {
    e.stopPropagation();
    const root = contentRef.current;
    if (!root || !sel) return;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    // Programmatic selections need a selectable subtree (see the long-press
    // handler); the flag stays on until the next plain touch on the page.
    root.classList.add('allow-sel');
    // The selection being reshaped is ours end to end: hold the lock so the
    // selectionchange bursts a drag produces never dismiss the toolbar.
    selLockRef.current = true;
    setSelDragging(true);
    let raf = 0;
    let px = 0;
    let py = 0;

    const rebuild = () => {
      raf = 0;
      const base = selRangeRef.current;
      if (!base) return;
      // The handle hangs below the text line; aim ~20px above the finger so
      // the caret lands on the line being adjusted.
      const caret = doc.caretRangeFromPoint?.(px, py - 20);
      if (
        !caret ||
        caret.startContainer.nodeType !== Node.TEXT_NODE ||
        !root.contains(caret.startContainer)
      ) {
        return;
      }
      const range = document.createRange();
      try {
        if (which === 'end') {
          range.setStart(base.startContainer, base.startOffset);
          range.setEnd(caret.startContainer, caret.startOffset);
        } else {
          range.setStart(caret.startContainer, caret.startOffset);
          range.setEnd(base.endContainer, base.endOffset);
        }
      } catch {
        return; // crossing containers the range cannot span
      }
      if (range.collapsed) return;
      const s = window.getSelection();
      if (s) {
        s.removeAllRanges();
        s.addRange(range);
      }
      applySelRange(range);
    };
    const onMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      px = t.clientX;
      py = t.clientY;
      if (ev.cancelable) ev.preventDefault();
      if (!raf) raf = window.requestAnimationFrame(rebuild);
    };
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove, true);
      window.removeEventListener('touchend', onEnd, true);
      window.removeEventListener('touchcancel', onEnd, true);
      if (raf) window.cancelAnimationFrame(raf);
      setSelDragging(false);
      // The gesture must not be read as a tap on the page underneath.
      turnedAtRef.current = Date.now();
    };
    // Capture on window: the touch stays targeted at the handle element, but
    // the page-turn listeners on the reader root must never see this drag.
    window.addEventListener('touchmove', onMove, { capture: true, passive: false });
    window.addEventListener('touchend', onEnd, true);
    window.addEventListener('touchcancel', onEnd, true);
  }

  // Builds the DOM range for source offsets [start, end) and selects it, so a
  // jump from the notebook or the annotation list lands with the target word
  // visibly locked and its toolbar ready — the visit exists to act on that
  // word, and making the reader re-select it by hand defeats the jump.
  function revealOffsets(start: number, end: number) {
    const root = contentRef.current;
    if (!root || end <= start) return;
    const s = textNodeAt(root, start);
    const e = textNodeAt(root, end - 1);
    if (!s || !e) return;
    const range = document.createRange();
    try {
      range.setStart(s.node, Math.min(s.offset, (s.node.textContent || '').length));
      range.setEnd(e.node, Math.min(e.offset + 1, (e.node.textContent || '').length));
    } catch {
      return;
    }
    if (range.collapsed) return;
    // Programmatic selection needs the selectable subtree (user-select:none
    // elsewhere), and the lock keeps it alive through selectionchange noise.
    root.classList.add('allow-sel');
    try {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      return;
    }
    selRangeRef.current = range;
    selLockRef.current = true;
    applySelRange(range);
  }

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const root = el;
    function onMouseUp() {
      // Any new interaction in the text dismisses the previous dictionary card.
      setLookupCard(null);
      syncSelectionFromDom();
    }
    // Debounced: the browser emits selectionchange continuously while a drag is
    // in progress, and the toolbar must land once the range settles rather than
    // being repositioned on every intermediate step.
    let selTimer = 0;
    function onSelectionChange() {
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(syncSelectionFromDom, 140);
    }
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const mark = target.closest('mark.hl') as HTMLElement | null;
      // The detour anchor is a mark without an annotation behind it; stopping
      // the event for it would swallow a page turn on that word.
      if (mark && mark.dataset.annId && mark.dataset.annId !== ANCHOR_ID) {
        e.stopPropagation();
        const ann = annotations.find((a) => a.id === mark.dataset.annId);
        if (ann) {
          const r = mark.getBoundingClientRect();
          setNoteDraft(ann.note);
          setPopover({ x: r.left + r.width / 2, y: r.bottom + 8, ann });
        }
        return;
      }
      // Paged mode has its own click router (onStageClick) that has to weigh a
      // click against the page-turn zones; scrolling has none, so the lookup
      // happens here.
      if (mode !== 'scroll') return;
      if (
        target.closest('a') ||
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea')
      ) {
        return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      // Touch division of labour, same as paged mode: a tap on a word looks it
      // up; only a tap in the middle third of the screen toggles the chrome —
      // the horizontal thirds do nothing in scroll mode (no pages to turn),
      // and a tap anywhere summoning the menu read as a bug.
      if (touchPrimary) {
        if (scheduleWordLookup(e.clientX, e.clientY)) return;
        const r = e.clientX / Math.max(1, window.innerWidth);
        if (r > 1 / 3 && r < 2 / 3) setChromeOpen((o) => !o);
        return;
      }
      scheduleWordLookup(e.clientX, e.clientY);
    }
    root.addEventListener('mouseup', onMouseUp);
    root.addEventListener('click', onClick);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      root.removeEventListener('mouseup', onMouseUp);
      root.removeEventListener('click', onClick);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.clearTimeout(selTimer);
    };
    // `html` is a dependency because on a cold open the content node does not
    // exist yet when this effect first runs — without it the listeners would
    // never attach and selecting text would do nothing.
  }, [mode, annotations, html, current, dictReady, touchPrimary]);

  /* ---- dictionary / vocabulary ---- */

  // One lookup path for both gestures: a selection sent with 查词, and a word
  // under a bare click. Both end up as the same card.
  async function runLookup(
    word: string,
    start: number,
    end: number,
    at: { x: number; top: number; bottom: number },
  ) {
    if (!current || !word) return;
    const root = contentRef.current;
    const context = root ? sentenceAt(root, start, end) : '';
    setLookupBusy(true);
    try {
      const res = await api.lookupWord(id, current, start, word, context);
      setLookupCard({
        ...at,
        res,
        offset: start,
        context,
        surface: word.replace(/[\u00AD\u200B-\u200D\uFEFF]/g, ''),
      });
    } catch (e) {
      toastError(e);
    } finally {
      setLookupBusy(false);
    }
  }

  async function lookupSelection() {
    if (!sel) return;
    const { text, start, end } = sel;
    const at = { x: sel.x, top: sel.y, bottom: sel.bottom };
    clearSelectionUI();
    await runLookup(text.trim(), start, end, at);
  }

  // The word under a point in the page, if the point is on one at all.
  //
  // `caretRangeFromPoint` alone is not enough: it SNAPS to the nearest caret,
  // which can land a character off the glyph the finger actually covered, and
  // it reports an element (not a text node) at tag boundaries. So the caret
  // only seeds a glyph scan: the character whose box really contains the point
  // wins, and the word is expanded from there. `allowCJK` opts the long-press
  // into treating a single Chinese character as the selectable unit — a bare
  // tap never passes it, so Chinese taps keep turning pages instead of opening
  // a dictionary that has no Chinese entries.
  function wordHitAt(
    x: number,
    y: number,
    allowCJK = false,
  ): {
    word: string;
    offset: number;
    rect: DOMRect;
    range: Range;
  } | null {
    const root = contentRef.current;
    if (!root) return null;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = doc.caretRangeFromPoint?.(x, y);
    if (!caret) return null;
    const node = caret.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer : null;
    if (!node || !root.contains(node)) return null;
    const text = node.textContent || '';
    // Glyph-precise index: scan a window around the snapped caret for the
    // character whose box covers the point. Without this the caret's own
    // snapping regularly resolved one glyph wide of the tap, and the expanded
    // "word" was a fragment of the neighbour.
    let idx = caret.startOffset;
    {
      const lo = Math.max(0, idx - 48);
      const hi = Math.min(text.length, idx + 48);
      const probe = document.createRange();
      for (let i = lo; i < hi; i++) {
        const ch = text[i];
        if (!ch || !ch.trim()) continue;
        probe.setStart(node, i);
        probe.setEnd(node, i + 1);
        // Fragment by fragment: the character after a hyphenation break unions
        // its glyph with the end of the previous line (see fragmentAt).
        if (fragmentAt(probe.getClientRects(), x, y, 3, 5)) {
          idx = i;
          break;
        }
      }
    }
    let span = wordAt(text, idx);
    if (!span && allowCJK) {
      let ci = idx;
      if (ci >= text.length || !isCJK(text[ci])) {
        if (ci > 0 && isCJK(text[ci - 1])) ci -= 1;
        else return null;
      }
      span = { start: ci, end: ci + 1, word: text[ci] };
    }
    if (!span) return null;
    // Words split across inline boundaries (a mark, an <em>) expand only to
    // the edge of this text node. When the expansion touches that edge, redo
    // it on the chapter's full text stream, where the pieces join up.
    //
    // That stream is `textContent`, which has no block boundaries in it: a
    // heading「Dedication」and the paragraph「This book is…」under it are
    // adjacent characters there, so the retry would happily return
    // "DedicationThis" for a tap on either. Only accept the wider span when
    // both of its ends live in the block the finger is in.
    if (span.start === 0 || span.end >= text.length) {
      const nodeStart = charOffset(root, node, 0);
      const rootText = root.textContent || '';
      const gIdx = nodeStart + idx;
      if (gIdx >= 0 && gIdx < rootText.length) {
        const rspan = wordAt(rootText, gIdx);
        if (rspan && rspan.end - rspan.start > span.end - span.start) {
          const s = textNodeAt(root, rspan.start);
          const e = textNodeAt(root, Math.max(rspan.start, rspan.end - 1));
          const block = blockOf(root, node);
          // Both ends inside the block the finger is in, and no forced line
          // break between them: those are exactly the places where the flat
          // text stream claims a word that the page does not show.
          if (
            s &&
            e &&
            block &&
            blockOf(root, s.node) === block &&
            blockOf(root, e.node) === block &&
            !lineBreakBetween(block, s.node, e.node)
          ) {
            const r2 = document.createRange();
            r2.setStart(s.node, Math.min(s.offset, (s.node.textContent || '').length));
            r2.setEnd(e.node, Math.min(e.offset + 1, (e.node.textContent || '').length));
            // Prefer the fragment under the finger; a word broken across
            // inline boundaries can still report a union box.
            const rect2 = fragmentAt(r2.getClientRects(), x, y, 4, 4) ?? r2.getBoundingClientRect();
            if (rect2.width > 0) {
              return { word: rspan.word, offset: rspan.start, rect: rect2, range: r2 };
            }
          }
        }
      }
    }
    const range = document.createRange();
    range.setStart(node, span.start);
    range.setEnd(node, span.end);
    // Trust the snap only when the point actually sits on the word (a little
    // slack for glyph edges) — and on the FRAGMENT of it that was tapped. A
    // word wrapped across lines has one fragment per line, and the union of
    // them is not a place any glyph is painted: anchoring the card to it put
    // the card over the wrong line.
    const rect = fragmentAt(range.getClientRects(), x, y, 4, 4);
    if (!rect) return null;
    return { word: span.word, offset: charOffset(root, node, span.start), rect, range };
  }

  function cancelWordLookup() {
    if (wordTimerRef.current !== null) {
      window.clearTimeout(wordTimerRef.current);
      wordTimerRef.current = null;
    }
  }

  // Returns true when the point is on a word, meaning this click has become a
  // lookup and the caller must not read it as anything else (page turn, chrome
  // toggle). The deferral is what keeps selecting text clean: the mousedown of
  // a double-click cancels this, so highlighting a word never flashes the card.
  function scheduleWordLookup(x: number, y: number): boolean {
    if (!current) return false;
    const hit = wordHitAt(x, y);
    if (!hit) return false;
    cancelWordLookup();
    const at = {
      x: hit.rect.left + hit.rect.width / 2,
      top: hit.rect.top,
      bottom: hit.rect.bottom,
    };
    wordTimerRef.current = window.setTimeout(() => {
      wordTimerRef.current = null;
      void runLookup(hit.word, hit.offset, hit.offset + hit.word.length, at);
    }, 160);
    return true;
  }

  // Any fresh press ends the interpretation of the previous click, and leaving
  // the reader must not fire a lookup afterwards.
  useEffect(() => {
    const onDown = () => cancelWordLookup();
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      cancelWordLookup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pronunciation lives in speech.ts: online dictvoice primary (the Android
  // WebView has no TTS voices), system speech synthesis as the offline
  // fallback on desktop.

  async function addCardToNotebook() {
    if (!lookupCard) return;
    const { res, offset, context } = lookupCard;
    const entry = res.entry;
    if (!entry) return;
    try {
      const v = await api.vocabAdd(
        entry.word,
        res.query || entry.word,
        id,
        current || '',
        offset,
        context,
      );
      setLookupCard({ ...lookupCard, res: { ...res, recorded: true, vocabId: v.id } });
      toast('已加入生词本', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  /* ---- annotation / bookmark actions ---- */
  // A highlight without a note is the common case, and both live in the same
  // popover. 批注 marks the range and hands the cursor to the note field: the
  // thought is written while the sentence is still on screen, instead of
  // marking now and coming back later to a page where the reader no longer
  // remembers why they marked it.
  async function createAnnotation(color: string, withNote = false) {
    if (!sel || !current) return;
    // clearSelectionUI drops `sel`, so the anchor has to be snapshotted first.
    const at = { x: sel.x, y: sel.bottom + 6 };
    try {
      const a = await api.addAnnotation(
        id,
        current,
        sel.start,
        sel.end,
        pageIndex,
        sel.text,
        color,
        '',
      );
      setAnnotations((prev) => [...prev, a]);
      setMarkColor(color);
      clearSelectionUI();
      if (withNote) {
        setNoteDraft('');
        setPopover({ ...at, ann: a, fresh: true });
      } else {
        toast('已划线', 'success');
      }
    } catch (e) {
      toastError(e);
    }
  }

  async function changeAnnColor(color: string) {
    const a = popover?.ann;
    if (!a) return;
    try {
      const upd = await api.updateAnnotation(a.id, color, noteDraft);
      setAnnotations((prev) => prev.map((x) => (x.id === a.id ? upd : x)));
      setPopover((p) => (p ? { ...p, ann: upd } : p));
    } catch (e) {
      toastError(e);
    }
  }

  async function saveAnnNote() {
    const a = popover?.ann;
    if (!a) return;
    try {
      const upd = await api.updateAnnotation(a.id, a.color, noteDraft);
      setAnnotations((prev) => prev.map((x) => (x.id === a.id ? upd : x)));
      setPopover((p) => (p ? { ...p, ann: upd } : p));
      setPopover(null);
      toast('已保存批注', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  async function removeAnnotation(aid: string) {
    try {
      await api.deleteAnnotation(aid);
      setAnnotations((prev) => prev.filter((x) => x.id !== aid));
      setPopover(null);
    } catch (e) {
      toastError(e);
    }
  }

  async function addBookmarkNow() {
    if (!current) return;
    try {
      // Both modes anchor to a source character offset; scrolling has no page
      // map, so the anchor is whatever text sits at the top of the pane.
      const off = mode === 'paged' ? offsetForPage(pageIndex) : offsetAtViewportTop();
      const b = await api.addBookmark(id, current, off, '');
      // Marking a spot that is already marked comes back as the row that was
      // there, so this merges rather than appending a twin of it.
      setBookmarks((prev) => (prev.some((x) => x.id === b.id) ? prev : [...prev, b]));
      toast('已添加书签', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  // The reading surface's text style. The custom family falls back to a serif
  // so Chinese/latin text stays legible during the (brief) font load.
  const contentStyle: CSSProperties = { fontSize };
  if (readFont !== 'default') contentStyle.fontFamily = `'${CUSTOM_FONT_FAMILY}', Georgia, serif`;

  async function removeBookmarks(ids: string[]) {
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((bid) => api.deleteBookmark(bid)));
      setBookmarks((prev) => prev.filter((x) => !ids.includes(x.id)));
      toast(ids.length > 1 ? `已删除 ${ids.length} 个书签` : '已删除书签', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  const removeBookmark = (bid: string) => removeBookmarks([bid]);

  // Every bookmark standing for "this page". Paged mode matches exactly via the
  // offset->page map; scrolling compares against the offset at the top of the
  // pane with slack, because the pane moves in pixel steps the map does not
  // model. Plural on purpose: a page can carry more than one mark (the drawer
  // used to add a new one on every press), and the star has to be able to turn
  // all of them off.
  function pageBookmarks(): Bookmark[] {
    if (!current) return [];
    if (mode === 'paged') {
      return bookmarks.filter(
        (b) => b.chapterId === current && pageIndexForOffset(b.anchor) === pageIndex,
      );
    }
    const top = offsetAtViewportTop();
    return bookmarks.filter((b) => b.chapterId === current && Math.abs(b.anchor - top) < 500);
  }

  // The bookmark standing for "this page" (phone: the star in the top bar).
  function currentPageBookmark(): Bookmark | null {
    return pageBookmarks()[0] ?? null;
  }

  // Bookmarking is one action with one meaning, and it has to be safe to press
  // twice: the star and the drawer's button both call this, and a double tap —
  // or a tap that lands while the first request is still in flight — must not
  // mark the page twice. Whoever gets through owns the interaction; the second
  // press is dropped instead of queued behind the first.
  const bookmarkBusyRef = useRef(false);

  async function togglePageBookmark() {
    if (bookmarkBusyRef.current) return;
    bookmarkBusyRef.current = true;
    try {
      const marks = pageBookmarks();
      if (marks.length > 0) await removeBookmarks(marks.map((b) => b.id));
      else await addBookmarkNow();
    } finally {
      bookmarkBusyRef.current = false;
    }
  }

  function jumpBookmark(b: Bookmark) {
    openChapter(b.chapterId, { type: 'restore', offset: b.anchor });
  }

  function jumpAnnotation(a: Annotation) {
    // Same treatment as a notebook jump: land on the page AND raise the
    // selection toolbar on the annotated range.
    pendingRevealRef.current = { start: a.startOffset, end: a.endOffset };
    openChapter(a.chapterId, { type: 'restore', offset: a.startOffset });
    setAnnOpen(false);
  }

  /* ---- render ---- */
  if (loading) return <div className="loading">加载中…</div>;
  if (!book) return <div className="page empty">书籍不存在</div>;

  /* ---- mobile chrome (微信读书 / 番茄 style) ----
     Top bar: back + chapter title + a page-bookmark star. Bottom: (paged) a
     chapter slider between 上一章/下一章, a percentage caption, and a four-slot
     action row (目录 · 书签 · 划线 · 设置). The desktop keeps its own bars —
     the two never render together, gated on touchPrimary.

     整理 is deliberately not one of them. It is chapter tooling — reorder a
     dragged chapter, publish an HTML editor, split a volume — and every one of
     those wants a mouse and a wide pane; on a phone it opened a desktop layout
     behind a reading session nobody meant to leave. The phone's book-level edit
     (title / author / tags / cover) lives on the shelf instead, behind a
     long-press, which is the whole of what a thumb can usefully do here. */
  // Only measured while the mobile chrome is actually up: in scroll mode the
  // helper walks text nodes, and doing that on every desktop render is waste.
  const pageBookmark = touchPrimary && chromeOpen ? currentPageBookmark() : null;
  // The drawer's button says the same thing as the star, so it needs the same
  // answer — and it must have one on desktop too, where the star does not exist.
  // Guarded on bmOpen so a closed drawer costs nothing.
  const pageMarked = pageBookmark !== null || (bmOpen && currentPageBookmark() !== null);

  const iconBack = (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
  const iconBookmark = (filled: boolean) => (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4h12v17l-6-4.2L6 21z" />
    </svg>
  );
  const iconToc = (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
  const iconPen = (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
  const iconListen = (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 15v-3a8 8 0 0116 0v3" />
      <path d="M4 15a2 2 0 012-2h1v5H6a2 2 0 01-2-2z" />
      <path d="M20 15a2 2 0 00-2-2h-1v5h1a2 2 0 002-2z" />
    </svg>
  );
  const mTabsRow = (
    <div className="m-tabs">
      <button className="m-tab" onClick={() => setTocOpen(true)}>
        {iconToc}
        <span>目录</span>
      </button>
      <button className="m-tab" onClick={() => setBmOpen(true)}>
        {iconBookmark(false)}
        <span>书签</span>
      </button>
      <button className="m-tab" onClick={() => setAnnOpen(true)}>
        {iconPen}
        <span>划线</span>
      </button>
      {/* 听书 starts where the reader is, not where the chapter starts — the
          natural way to pick it up is "read this to me" from the page I am on. */}
      <button
        className={`m-tab${listen ? ' listening' : ''}`}
        onClick={() => (listen ? setChromeOpen(false) : startListen())}
      >
        {iconListen}
        <span>{listen ? '听书中' : '听书'}</span>
      </button>
      <button className="m-tab" onClick={() => setSettingsOpen(true)}>
        <span className="m-aa">Aa</span>
        <span>设置</span>
      </button>
    </div>
  );

  // The touch chrome is ALWAYS mounted; closed state is just .chrome-hidden
  // (opacity/visibility). Mounting and unmounting fixed bars forces Android
  // WebView to rebuild its layer tree, which flashed the whole page — the
  // transition below reads as an animation instead of a repaint glitch.
  const chromeCls = chromeOpen ? '' : ' chrome-hidden';

  const mTopBar = (
    <div className={`reader-chrome top m-top${chromeCls}`}>
      <button
        className="chrome-icon"
        onClick={exitReading}
        aria-label={preview ? '返回来源页' : '返回书架'}
      >
        {iconBack}
      </button>
      <div className="m-title">{currentChapter?.title || book.title}</div>
      <button
        className="chrome-icon text ai-guide-btn"
        onClick={openGuide}
        title="让 AI 读一遍本章，生成导读"
      >
        ✦AI
      </button>
      <button
        className={`chrome-icon star${pageBookmark ? ' on' : ''}`}
        onClick={togglePageBookmark}
        aria-label={pageBookmark ? '移除本页书签' : '添加书签'}
      >
        {iconBookmark(!!pageBookmark)}
      </button>
    </div>
  );

  // Paged bottom bar: the slider is chapter-local (what 番茄 does) — chapter
  // jumps live on its two ends. Dragging only moves pageIndex, so the offset
  // map stays valid and no re-measure is needed.
  const mBottomPaged = (
    <div className={`reader-chrome bottom m-bottom${chromeCls}`}>
      <div className="m-slider-row">
        <button
          className="chrome-icon text"
          disabled={!prev || !!preview}
          onClick={() => prev && openChapter(prev.id, { type: 'last' })}
        >
          上一章
        </button>
        <input
          className="m-slider"
          type="range"
          min={0}
          max={Math.max(0, maxPageIndex)}
          value={Math.min(pageIndex, maxPageIndex)}
          disabled={!!preview}
          onChange={(e) => {
            setLookupCard(null);
            setSel(null);
            setPopover(null);
            setPageIndex(Number(e.target.value));
          }}
          aria-label="阅读进度"
        />
        <button
          className="chrome-icon text"
          disabled={!next || !!preview}
          onClick={() => next && openChapter(next.id, { type: 'first' })}
        >
          下一章
        </button>
      </div>
      {/* The footer splits what used to be one centred string: page number at
          the left edge, whole-book progress at the right — both under a thumb,
          neither in the dead centre of the screen. 全书 has to be spelled out:
          the two numbers have different denominators (this chapter's pages vs
          the whole book), and an unlabelled "38%" beside "第 3/12 页" invites
          reading one as a restatement of the other. The percentage is
          continuous — chapter index plus the position inside the chapter, with
          every chapter counted as if it were the same length — so it moves a
          point or two per page and is an estimate, not a measurement. */}
      <div className="m-foot">
        <span className="m-foot-page">
          {pageCount ? `第 ${pageIndex + 1}/${pageCount} 页` : ''}
        </span>
        <span className="m-foot-pct">
          <span className="m-foot-pct-lb">全书</span>
          {Math.round(progressPct)}%
        </span>
      </div>
      {mTabsRow}
    </div>
  );

  const mBottomScroll = (
    <div className={`reader-chrome bottom m-bottom${chromeCls}`}>{mTabsRow}</div>
  );

  // Overlays live outside both reading layouts: they are viewport-anchored, and
  // keeping one copy is what makes "select a word, look it up" work while
  // scrolling as well as while paging.

  // A failed AI ask is very often a settings problem, so the error state offers
  // a way there — which first has to close the panel, or it would cover the
  // settings page it just navigated to.
  const goAISettings = () => {
    setAIPanel(null);
    nav('/settings');
  };
  // "查看对话" — every grounded answer is filed as a transcript, so the answer
  // in front of the reader has a page where it can be read in full and
  // continued (system prompt and all). The panel closes first: this leaves the
  // reader, and a sheet left open would still be mounted over the next page.
  const openChat = (convId: string) => {
    if (!convId) return;
    setAIPanel(null);
    setLookupCard(null);
    nav(`/ai/${convId}`);
  };
  // One way into the AI for a word, shared by the card's ✦ and by the "not in
  // the dictionary" state — where the model is the only answer there is, so the
  // entry has to be as easy to find there as on a word that was found.
  //
  // Opening the panel closes the card: the card is the smaller answer to the
  // question the panel answers in full, and leaving it up would park a
  // duplicate over the page the panel is meant to leave readable.
  const explainThis = () => {
    if (!lookupCard) return;
    // The dictionary's headword when it found one (a lemma explains better than
    // an inflected form), otherwise the word as printed — which is also what
    // the card shows, so the panel and the tap agree.
    const word = lookupCard.res.entry?.word || lookupCard.surface || lookupCard.res.query;
    const sentence = lookupCard.context;
    setLookupCard(null);
    setAIPanel({ kind: 'explain', word, sentence });
  };
  // The word as the reader sees it on the page. Falls back to the dictionary's
  // normalised query for an older card state.
  const cardWord = lookupCard ? lookupCard.surface || lookupCard.res.query : '';
  // Where the cached gloss's conversation lives, if it has one (it does unless
  // the answer predates the transcript store).
  const cardChatId = cardAI?.conversationId ?? '';
  // The cached gloss itself is fetched by the effect near the state
  // declarations (before the loading return); this block only draws it.

  // The cached AI gloss as the card shows it — the same block in both the
  // dictionary-miss state (where it replaces "未收录") and the found state
  // (where it sits under the dictionary entry).
  const cardAIGloss = cardAI && (
    <div className="dict-ai">
      <div className="dict-ai-head">
        <span className="dict-ai-star" aria-hidden="true">
          ✦
        </span>
        AI 解释 · 本句
        {cardAI.pos && <span className="ai-pos">{cardAI.pos}</span>}
      </div>
      {cardAI.meaning && <div className="dict-ai-meaning">{cardAI.meaning}</div>}
      {cardAI.translation && <div className="dict-ai-trans">整句：{cardAI.translation}</div>}
      {cardAI.note && <div className="dict-ai-note">{cardAI.note}</div>}
      {cardChatId && (
        <button className="dict-ai-open" onClick={() => openChat(cardChatId)}>
          查看对话 <span aria-hidden="true">›</span>
        </button>
      )}
    </div>
  );

  const overlayLayer = (
    <>
      {/* 听书 sentence band. One absolutely-positioned box per line fragment of
          the sentence being spoken — drawn on a fixed layer, never as a span
          injected into the chapter, because that DOM belongs to React and
          unwrapping it later is how a reader ends up with a black screen. */}
      {listenMarks.length > 0 && (
        <div className="listen-marks" aria-hidden="true">
          {listenMarks.map((m, i) => (
            <span key={i} style={{ left: m.left, top: m.top, width: m.width, height: m.height }} />
          ))}
        </div>
      )}
      {/* selection toolbar — stays up while a handle is dragged: the drag is
          how you make the selection you are about to look up, and hiding the
          menu mid-gesture read as "the menu is gone" (it only came back once
          the finger was lifted). */}
      {sel && (
        <div
          className={`sel-toolbar${selDragging ? ' dragging' : ''}`}
          ref={selPos.ref}
          style={overlayStyle(selPos.pos)}
        >
          <button
            className="sel-lookup"
            title="查词"
            onClick={lookupSelection}
            disabled={lookupBusy}
          >
            {lookupBusy ? '查询中' : '查词'}
          </button>
          {/* Read from here: the paragraph you selected is the paragraph you
              want read, not the top of the page. */}
          <button
            className="sel-listen"
            title="从这里开始朗读"
            onClick={() => {
              const at = sel.start;
              clearSelectionUI();
              startListen(at);
            }}
          >
            朗读
          </button>
          {/* Translation and breakdown share one view (0.4 裁决): the sentence
              is already on screen, so the panel echoes it and adds meaning
              around it rather than opening a second page. */}
          <button
            className="ai-chip"
            title="AI 翻译并拆解这个句子"
            onClick={() => {
              // The panel takes over the screen: leaving the selection toolbar
              // and the highlighted range up would park a floating strip of
              // buttons over the chapter heading while the reader reads the
              // answer (seen on the phone).
              setAIPanel({ kind: 'parse', sentence: sel.text });
              clearSelectionUI();
            }}
          >
            ✦ AI
          </button>
          {/* Highlights are painted by the paginated view only, so offering
              colours while scrolling would promise something invisible. 批注
              goes with them for the same reason: a note hangs off a highlight,
              and there is no highlight to hang it on in scroll mode. */}
          {mode === 'paged' && (
            <button
              className="sel-note"
              title="划线并添加批注"
              onClick={() => createAnnotation(markColor, true)}
            >
              批注
            </button>
          )}
          {mode === 'paged' &&
            COLORS.map((c) => (
              <button
                key={c}
                className={`swatch sw-${c}`}
                title={c}
                onClick={() => createAnnotation(c)}
              />
            ))}
        </div>
      )}

      {/* Selection drag handles (touch, paged): hang below the first/last line
          fragment; dragging one reshapes the selection word by word. Native
          handles do not exist here — the paged content is user-select:none and
          the selection is built programmatically. */}
      {sel && touchPrimary && mode === 'paged' && sel.firstRect && sel.lastRect && (
        <>
          <span
            className="sel-handle"
            style={{ left: sel.firstRect.left - 8, top: sel.firstRect.bottom + 1 }}
            onTouchStart={(e) => startHandleDrag(e, 'start')}
            aria-hidden="true"
          />
          <span
            className="sel-handle end"
            style={{ left: sel.lastRect.right - 14, top: sel.lastRect.bottom + 1 }}
            onTouchStart={(e) => startHandleDrag(e, 'end')}
            aria-hidden="true"
          />
        </>
      )}

      {/* dictionary card — fixed layer, never part of the page layout */}
      {lookupCard && (
        <div className="dict-card" ref={dictPos.ref} style={overlayStyle(dictPos.pos)}>
          <button className="dict-close" title="关闭" onClick={() => setLookupCard(null)}>
            ×
          </button>
          {!lookupCard.res.found || !lookupCard.res.entry ? (
            cardAI ? (
              <>
                {cardAIGloss}
                <div className="dict-miss-hint">
                  这是之前 AI 对「{cardWord}」的解释。词库未收录此词。
                </div>
                <button className="ai-fallback" onClick={explainThis}>
                  <span className="ai-fallback-star" aria-hidden="true">
                    ✦
                  </span>
                  重新问 AI
                </button>
              </>
            ) : (
              <div className="dict-miss">
                {!dictReady ? (
                  <>
                    <div className="dict-miss-title">词库未安装</div>
                    <div className="dict-miss-hint">在「我的 → 查词词库」可在线下载</div>
                  </>
                ) : (
                  <>
                    <div className="dict-miss-title">
                      词库未收录 <b>{cardWord}</b>
                    </div>
                    {/* A word the dictionary does not have is usually a name, a
                      coinage or a domain term — which is exactly the word a
                      reader needs help with. Ending the answer at "未收录" is
                      the least useful thing the card could do, so the model is
                      offered right here, at full size. */}
                    <div className="dict-miss-hint">
                      人名、地名、专业词常不在词库里。AI 可以结合这一句解释它，并把整句翻成中文。
                    </div>
                  </>
                )}
                <button className="ai-fallback" onClick={explainThis}>
                  <span className="ai-fallback-star" aria-hidden="true">
                    ✦
                  </span>
                  让 AI 解释「{cardWord}」
                </button>
              </div>
            )
          ) : (
            <>
              <div className="dict-head">
                <span className="dict-word">{lookupCard.res.entry.word}</span>
                {lookupCard.res.entry.phonetic && (
                  <span className="dict-phon">/{lookupCard.res.entry.phonetic}/</span>
                )}
                <button
                  className="dict-speak"
                  title="朗读"
                  onClick={() => speakWord(lookupCard.res.entry?.word || '')}
                >
                  发音
                </button>
              </div>
              {lookupCard.res.entry.translation ? (
                <div className="dict-trans">{lookupCard.res.entry.translation}</div>
              ) : (
                <div className="dict-trans muted">
                  {lookupCard.res.entry.definition || '暂无释义'}
                </div>
              )}
              {lookupCard.res.base && (
                <div className="dict-base">
                  <span className="dict-base-label">原型</span>
                  <b>{lookupCard.res.base.word}</b>
                  {lookupCard.res.base.phonetic && (
                    <span className="dict-phon">/{lookupCard.res.base.phonetic}/</span>
                  )}
                  {lookupCard.res.base.translation && (
                    <div className="dict-base-trans">{lookupCard.res.base.translation}</div>
                  )}
                </div>
              )}
              {/* Asked the AI about this word in this sentence before? The
                  answer is already on the device — show it without a tap. */}
              {cardAIGloss}
              <div className="dict-foot">
                {lookupCard.res.recorded ? (
                  <span className="dict-saved">已在生词本</span>
                ) : (
                  <>
                    <span className="muted">
                      {lookupCard.res.common ? '常用词，不自动收录' : '再查一次自动收录'}
                    </span>
                    <button className="btn sm" onClick={addCardToNotebook}>
                      加入生词本
                    </button>
                  </>
                )}
                {/* Always offered: the model explains the word from the
                    sentence, so it does not need the dictionary to have found
                    anything. */}
                <button
                  className="ai-chip"
                  title="结合当前句子，让 AI 解释这个词，并翻译整句"
                  onClick={explainThis}
                >
                  ✦ AI
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* annotation popover */}
      {popover && (
        <div className="ann-popover" ref={popPos.ref} style={overlayStyle(popPos.pos)}>
          {/* The marked sentence, echoed back: on a phone the popover sits over
              the line it belongs to, and once the keyboard is up that line is
              covered — a note written without it is a note about nothing. */}
          <div className="ann-quote">{popover.ann.text}</div>
          <div className="ann-pop-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch sw-${c}${popover.ann.color === c ? ' on' : ''}`}
                onClick={() => changeAnnColor(c)}
              />
            ))}
          </div>
          <textarea
            ref={noteRef}
            className="ann-note"
            placeholder="添加批注…"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
          />
          <div className="ann-pop-actions">
            <button className="btn sm" onClick={saveAnnNote}>
              保存
            </button>
            <button className="btn sm danger" onClick={() => removeAnnotation(popover.ann.id)}>
              删除
            </button>
          </div>
        </div>
      )}

      {/* mobile reading settings (Aa) */}
      {settingsOpen && (
        <div className="sheet-mask" onClick={() => setSettingsOpen(false)}>
          <div className="sheet rd-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="rd-set-row">
              <span className="rd-set-label">字号</span>
              <div className="rd-set-ctrl">
                <button className="rd-a" onClick={() => setFontSize((f) => Math.max(13, f - 1))}>
                  A−
                </button>
                <span className="rd-font-preview" style={{ fontSize: Math.min(fontSize, 30) }}>
                  字
                </span>
                <button className="rd-a" onClick={() => setFontSize((f) => Math.min(26, f + 1))}>
                  A+
                </button>
              </div>
            </div>
            <div className="rd-set-row">
              <span className="rd-set-label">翻页</span>
              <div className="rd-seg">
                <button className={mode === 'paged' ? 'on' : ''} onClick={() => setMode('paged')}>
                  翻页
                </button>
                <button className={mode === 'scroll' ? 'on' : ''} onClick={() => setMode('scroll')}>
                  滚动
                </button>
              </div>
            </div>
            {/* How far a horizontal drag has to go. The number shown is the
                one the gesture actually uses, measured against this spread, so
                a reader can pick a level and see what it means in pixels
                instead of guessing what "灵敏" is worth. */}
            <div className="rd-set-row">
              <span className="rd-set-label">
                翻页灵敏度
                <small className="rd-set-desc">
                  拖过约 {Math.round(turnThresholds(turnSens, turnGeomRef.current.stride).far)} px
                  翻页
                </small>
              </span>
              <div className="rd-seg tight">
                {TURN_SENSITIVITY_LEVELS.map((l) => (
                  <button
                    key={l.id}
                    className={turnSens === l.id ? 'on' : ''}
                    aria-pressed={turnSens === l.id}
                    onClick={() => setTurnSens(l.id)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Reading font: 默认 plus the open-source catalogue (download on
                first tap). Shared with the Me→设置 page. */}
            <div className="rd-set-row rd-font-row">
              <span className="rd-set-label">字体</span>
              <FontPicker value={readFont} onChange={setReadFont} />
            </div>
            <div className="rd-set-row">
              <span className="rd-set-label">
                覆盖书籍字体
                <small className="rd-set-desc">忽略 EPUB 内嵌字体设定</small>
              </span>
              <button
                role="switch"
                aria-checked={fontOverride}
                aria-label="覆盖书籍字体"
                className={`rd-switch${fontOverride ? ' on' : ''}`}
                onClick={() => setFontOverride((v) => !v)}
              >
                <span className="rd-switch-knob" />
              </button>
            </div>
            <div className="rd-set-row last">
              <span className="rd-set-label">主题</span>
              <div className="rd-themes">
                {APP_THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`rd-theme t-${t.id}${theme === t.id ? ' on' : ''}`}
                    onClick={() => {
                      // One call re-themes every surface: it writes the key and
                      // flips html[data-app-theme], which the CSS variables hang off.
                      applyAppTheme(t.id);
                      setTheme(t.id);
                    }}
                  >
                    <span className="rd-theme-dot" />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-send privacy confirmation (0.4 裁决：每次问). The chapter text is
          about to leave the device, so this says exactly what goes where before
          anything is sent — and 6000 mirrors the backend's prompt budget.
          Nothing configured yet? Then there is nothing to consent to: the same
          dialog turns into a door to settings rather than a send that would
          come back as an error. */}
      {guideAsk && (
        <div className="modal-backdrop" onClick={() => setGuideAsk(null)}>
          <div className="modal ai-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              {guideAsk.configured ? (
                <>
                  <p>
                    本章导读由 AI 生成：需要把本章正文（约 <b>{guideAsk.chars.toLocaleString()}</b>{' '}
                    字{guideAsk.chars > 6000 ? '，较长章节仅发送开头部分' : ''}）发送到「
                    {guideAsk.model || 'AI 服务'}」。
                  </p>
                  <p>回答由模型生成，可能不准确，请以原文为准。</p>
                </>
              ) : (
                <>
                  <p>还没有配置 AI 服务，暂时无法生成导读。</p>
                  <p>填写接口地址与模型（以及密钥）后即可使用；查词释义、句子拆解同样需要它。</p>
                </>
              )}
            </div>
            <div className="ai-confirm-actions">
              <button className="btn sm" onClick={() => setGuideAsk(null)}>
                取消
              </button>
              {guideAsk.configured ? (
                <button
                  className="btn sm primary"
                  onClick={() => {
                    setGuideAsk(null);
                    setAIPanel({ kind: 'summary' });
                  }}
                >
                  生成导读
                </button>
              ) : (
                <button
                  className="btn sm primary"
                  onClick={() => {
                    setGuideAsk(null);
                    goAISettings();
                  }}
                >
                  去设置
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* The AI panel: one surface, three callers. Each `run` is the grounded
          ask — the word card's word + sentence + dictionary senses, the
          selection's sentence, the chapter behind the reader. */}
      {aiPanel?.kind === 'explain' && (
        <AIPanel<ExplainResult>
          title="✦ AI 释义"
          run={() => api.explainInContext(aiPanel.word, aiPanel.sentence)}
          render={(r) => (
            <>
              {r.cached && <span className="ai-cache-badge">缓存结果</span>}
              <AISentence text={aiPanel.sentence}>
                {highlightWord(aiPanel.sentence, aiPanel.word)}
              </AISentence>
              {r.meaning && (
                <>
                  <div className="ai-label">
                    在本句中
                    {r.pos && <span className="ai-pos">{r.pos}</span>}
                  </div>
                  <p className="ai-explain">{r.meaning}</p>
                </>
              )}
              {r.note && <p className="ai-note">{r.note}</p>}
              {r.translation && (
                <>
                  <div className="ai-label">整句翻译</div>
                  <p className="ai-trans">{r.translation}</p>
                </>
              )}
            </>
          )}
          onClose={() => setAIPanel(null)}
          onGoSettings={goAISettings}
          chatId={(r) => r.conversationId}
          onOpenChat={openChat}
        />
      )}

      {aiPanel?.kind === 'parse' && (
        <AIPanel<ParseResult>
          title="✦ AI 拆句"
          run={() => api.parseSentence(aiPanel.sentence)}
          render={(r) => (
            <>
              {r.cached && <span className="ai-cache-badge">缓存结果</span>}
              <AISentence text={aiPanel.sentence}>{aiPanel.sentence}</AISentence>
              {r.translation && <p className="ai-trans">{r.translation}</p>}
              {r.segments.length > 0 && (
                <>
                  <div className="ai-label">句子拆解</div>
                  {r.segments.map((s, i) => (
                    <div className="ai-seg" key={i}>
                      <span className="ai-seg-text">{s.text}</span>
                      <span className="ai-seg-role">{s.role}</span>
                      <span className="ai-seg-gloss">{s.gloss}</span>
                    </div>
                  ))}
                </>
              )}
              {r.notes.length > 0 && (
                <>
                  <div className="ai-label">语法注释</div>
                  <div className="ai-notes">
                    <ul>
                      {r.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </>
          )}
          onClose={() => setAIPanel(null)}
          onGoSettings={goAISettings}
          chatId={(r) => r.conversationId}
          onOpenChat={openChat}
        />
      )}

      {aiPanel?.kind === 'summary' && current && (
        <AIPanel<SummaryResult>
          title="✦ AI 导读"
          run={() => api.summarizeChapter(id, current)}
          render={(r) => (
            <>
              {r.cached && <span className="ai-cache-badge">缓存结果</span>}
              {r.truncated && <p className="ai-trunc">本章较长，导读基于开头部分生成。</p>}
              <p className="ai-summary">{r.summary}</p>
              {r.points.length > 0 && (
                <>
                  <div className="ai-label">本章要点</div>
                  <div className="ai-points">
                    <ul>
                      {r.points.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
              {r.terms.length > 0 && (
                <>
                  <div className="ai-label">值得记住的词</div>
                  <div className="ai-term-row">
                    {r.terms.map((t, i) => (
                      <span className="ai-term" key={i}>
                        <b>{t.term}</b>
                        <em>{t.gloss}</em>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          onClose={() => setAIPanel(null)}
          onGoSettings={goAISettings}
          chatId={(r) => r.conversationId}
          onOpenChat={openChat}
        />
      )}

      {/* 听书 bar. A control, not a dialog: it rides above the page and below
          every sheet, and it stays mounted for as long as the session lives
          (the reader may turn the chrome off and still want pause). */}
      {listen && (
        <ListenBar
          title={currentChapter?.title || book.title}
          playing={listen.playing}
          rate={listen.rate}
          index={listen.index}
          total={spansRef.current.length}
          voiceLabel={listen.engine === 'online' ? listenVoiceLabel() : undefined}
          onToggle={toggleListen}
          onPrev={() => jumpListen(-1)}
          onNext={() => jumpListen(1)}
          onRate={changeListenRate}
          onSettings={() => setListenSheet(true)}
          onClose={stopListen}
          // Clear of the bottom chrome while it is up (the detour bar uses the
          // same two numbers), flush to the edge when it is not.
          style={{ bottom: chromeOpen ? (touchPrimary ? 158 : 58) : 14 }}
        />
      )}

      {listenSheet && (
        <div className="sheet-mask" onClick={() => setListenSheet(false)}>
          <div className="sheet rd-sheet" onClick={(e) => e.stopPropagation()}>
            {/* Two engines, one switch. 系统 is the phone's own TTS: free,
                offline, unlimited, and a bit robotic. 在线 is a neural voice
                that needs the network and is not an official API — the note
                under the switch says so rather than pretending otherwise. */}
            <div className="rd-set-row">
              <span className="rd-set-label">
                音色来源
                <small className="rd-set-desc">
                  {listenEngine === 'online'
                    ? '在线音色需联网，音质接近真人'
                    : '系统引擎：离线可用，不限量，声音偏机械'}
                </small>
              </span>
              <div className="rd-seg tight">
                <button
                  className={listenEngine === 'system' ? 'on' : ''}
                  onClick={() => switchListenEngine('system')}
                >
                  系统
                </button>
                <button
                  className={listenEngine === 'online' ? 'on' : ''}
                  onClick={() => switchListenEngine('online')}
                >
                  在线
                </button>
              </div>
            </div>
            {listenEngine === 'online' && (
              <div className="rd-set-row rd-voice-row">
                <span className="rd-set-label">音色</span>
                <div className="rd-voices">
                  {(edgeVoices || []).map((v) => (
                    <button
                      key={v.name}
                      className={`rd-voice${listenVoice === v.name ? ' on' : ''}`}
                      onClick={() => switchListenVoice(v.name)}
                    >
                      {v.label}
                    </button>
                  ))}
                  {!edgeVoices?.length && <span className="rd-set-desc">载入中…</span>}
                </div>
              </div>
            )}
            <div className="rd-set-row last">
              <span className="rd-set-label">语速</span>
              <div className="rd-seg tight">
                {LISTEN_RATES.map((r) => (
                  <button
                    key={r}
                    className={listenRate === r ? 'on' : ''}
                    onClick={() => setListenRateTo(r)}
                  >
                    {r}×
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // The preview toolbar: exactly three regular buttons, nothing else — the
  // visit itself speaks through the anchored highlight, not through banners or
  // auto-raised menus.
  //
  // Floating above the page it sits clear of the bottom chrome instead of under
  // it, so the buttons never end up behind a bar that appears on approach.
  const previewSrc = preview ? PREVIEW_SOURCE[preview.source] : null;
  const detourBar =
    preview && previewSrc ? (
      <div
        className={`detour-bar${mode === 'paged' ? ' floating' : ''}`}
        style={mode === 'paged' && chromeOpen ? { bottom: touchPrimary ? 132 : 58 } : undefined}
      >
        <button className="btn sm" onClick={() => goUp(previewSrc.back)} title="返回来源列表">
          返回
        </button>
        <button
          className="btn sm"
          disabled={!origin || !origin.chapterId}
          onClick={jumpToLastReading}
          title={origin ? '回到上次读到的地方，正常阅读' : '这本书还没有阅读记录'}
        >
          跳到最后阅读
        </button>
        <button
          className="btn sm"
          onClick={resumeFromPreview}
          title="把当前位置记为阅读进度，从这里开始正常阅读"
        >
          从当前开始阅读
        </button>
      </div>
    ) : null;

  if (mode === 'scroll') {
    return (
      <div className="reader">
        <aside className="toc">
          <div className="toc-head">
            目录 · {chapters.length} 章
            <button
              className="toc-locate"
              title="定位到当前章节"
              onClick={locateCurrent}
              aria-label="定位到当前章节"
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
            </button>
          </div>
          {useTocTree ? (
            <TocTree
              entries={mergedToc}
              itemClass="toc-item"
              activeSet={activeSet}
              resolve={resolveTocHref}
              onPick={openChapter}
              collapsed={tocCollapsed}
              onToggle={toggleToc}
            />
          ) : (
            chapters.map((c, i) => (
              <button
                key={c.id}
                className={`toc-item${c.id === current ? ' active' : ''}`}
                onClick={() => openChapter(c.id)}
                title={c.title}
              >
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                {c.title}
              </button>
            ))
          )}
        </aside>

        <div className="reader-main" ref={mainRef}>
          <div className="reader-head">
            {detourBar}
            <div className="reader-toolbar">
              <div className="crumb">
                <strong>{book.title}</strong>
                <span>·</span>
                <span>{book.author || '未知作者'}</span>
              </div>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setFontSize((f) => Math.max(13, f - 1))}>
                A−
              </button>
              <span className="muted" style={{ fontSize: 12, minWidth: 30, textAlign: 'center' }}>
                {fontSize}
              </span>
              <button className="btn sm" onClick={() => setFontSize((f) => Math.min(26, f + 1))}>
                A+
              </button>
              <button className="btn sm" onClick={() => setMode('paged')}>
                翻页模式
              </button>
              <button
                className="btn sm ai-guide-btn"
                onClick={openGuide}
                title="让 AI 读一遍本章，生成导读"
              >
                ✦ AI 导读
              </button>
              <Link className="btn sm" to={`/books/${id}/edit`}>
                整理
              </Link>
              <button className="btn sm" onClick={() => (listen ? stopListen() : startListen())}>
                {listen ? '停止朗读' : '听书'}
              </button>
              <button
                className="btn sm"
                onClick={() => (preview ? goUp(PREVIEW_SOURCE[preview.source].back) : goUp('/'))}
              >
                {preview ? '返回' : '书架'}
              </button>
            </div>
          </div>

          <article className="reader-paper">
            <div
              className="reader-content"
              ref={contentRef}
              style={contentStyle}
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          </article>

          {flash && (
            <div
              className="jump-flash"
              style={{ left: flash.left, top: flash.top, width: flash.width, height: flash.height }}
            />
          )}

          {overlayLayer}

          <div className="reader-nav">
            <button className="btn" disabled={!prev} onClick={() => prev && openChapter(prev.id)}>
              ← {prev ? prev.title.slice(0, 18) : '已是第一章'}
            </button>
            <button className="btn" disabled={!next} onClick={() => next && openChapter(next.id)}>
              {next ? next.title.slice(0, 18) : '已是最后一章'} →
            </button>
          </div>
        </div>

        {touchPrimary && (
          <>
            {mTopBar}
            {mBottomScroll}
          </>
        )}
      </div>
    );
  }

  /* ---- paged immersive mode ---- */
  // Touch layout: the sheet is the screen (see measureAndLayout). Everything
  // that sells "a book lying on a desk" — corner radius, drop shadow, the stack
  // of pages peeking out — is dropped, because there is no desk in frame.
  const fillLayout = touchPrimary;
  const viewWidth = pagesPerView * sheetWidth + (pagesPerView - 1) * pageGap;
  const columnGap = sheetWidth + pageGap - contentWidth;
  const geometryReady = sheetWidth > 0 && contentWidth > 0;
  // Covered page-edge thickness: how much of the "next/previous pages" stack
  // peeks out beyond the current sheet, and how much tucks under it.
  const bookEdgeW = 30;
  const bookEdgeTuck = 8;
  const bookEdgeVisible = bookEdgeW - bookEdgeTuck;
  // Only render the sheets actually on screen (1 or 2) so no third-page edge leaks.
  const visibleSheets = geometryReady
    ? Math.min(pagesPerView, Math.max(0, pageCount - pageIndex))
    : 0;

  return (
    <div
      className={
        'reader reader-paged' +
        (tocDocked ? ' toc-docked' : '') +
        (fillLayout ? ' reader-fill' : '')
      }
      ref={readerRef}
    >
      {tocDocked && (
        <aside className="toc-dock">
          <div className="toc-head">
            目录 · {chapters.length} 章
            <button
              className="toc-locate"
              title="定位到当前章节"
              onClick={locateCurrent}
              aria-label="定位到当前章节"
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
            </button>
            <button className="btn sm" onClick={() => setTocDocked(false)} title="取消固定目录">
              ✕
            </button>
          </div>
          <div className="toc-dock-body">
            {useTocTree ? (
              <TocTree
                entries={mergedToc}
                itemClass="toc-item"
                activeSet={activeSet}
                resolve={resolveTocHref}
                onPick={openChapter}
                collapsed={tocCollapsed}
                onToggle={toggleToc}
              />
            ) : (
              chapters.map((c, i) => (
                <button
                  key={c.id}
                  className={`toc-item${c.id === current ? ' active' : ''}`}
                  onClick={() => openChapter(c.id)}
                  title={c.title}
                >
                  <span className="num">{String(i + 1).padStart(2, '0')}</span>
                  {c.title}
                </button>
              ))
            )}
          </div>
        </aside>
      )}
      <div
        className="reader-stage"
        ref={stageRef}
        onClick={onStageClick}
        onMouseDown={onStageMouseDown}
        onMouseMove={onStageMouseMove}
        onMouseUp={onStageMouseUp}
        onMouseLeave={onStageMouseUp}
      >
        <div
          className={`reader-spread${fxOut ? ' fx-out' : ''}${turnFx ? ' turning' : ''}${
            turnDrag ? (turnDrag.phase === 'follow' ? ' turn-drag' : ' turn-settle') : ''
          }`}
          ref={spreadRef}
          style={{
            width: Math.max(0, viewWidth),
            height: Math.max(0, sheetHeight),
          }}
        >
          {/* Covered page edges: the rest of the book peeking out from behind the
              current sheet(s), so it reads like an open book. Each side only
              appears when the book actually continues that way — the stack is
              also the target for a page-edge click, and an edge that leads
              nowhere would be a promise the click cannot keep.
              Not on touch: the sheet is flush with the screen, so the stack
              would sit off-screen (and the page-turn bands cover the gesture). */}
          {geometryReady && !fillLayout && (
            <>
              {pageIndex > 0 && (
                <div
                  className="book-edge left"
                  style={{ left: -bookEdgeVisible, width: bookEdgeW, height: sheetHeight }}
                />
              )}
              {pageIndex + pagesPerView < pageCount && (
                <div
                  className="book-edge right"
                  style={{ left: viewWidth - bookEdgeTuck, width: bookEdgeW, height: sheetHeight }}
                />
              )}
            </>
          )}
          {geometryReady &&
            Array.from({ length: visibleSheets }).map((_, j) => {
              const i = pageIndex + j;
              // Which side of the spread the sheet sits on. For a full spread
              // this matches page parity (even page on the left), but the last
              // spread of an odd-page chapter holds one page in the left slot:
              // by parity it would take a right-hand sheet's rounding and page
              // number, backwards for a page whose gutter is on its right. The
              // slot is the truth; parity was only ever its shortcut.
              const isLeft = pagesPerView === 1 ? i % 2 === 0 : j === 0;
              // Like a real book: the page number sits in the outer bottom
              // corner. A single page uses the right corner; in a spread the
              // left sheet uses the left corner and the right sheet the right.
              const corner = pagesPerView === 1 ? 'right' : isLeft ? 'left' : 'right';
              return (
                <div
                  key={i}
                  className={`page-sheet${isLeft ? ' left' : ' right'}`}
                  style={{
                    left: j * (sheetWidth + pageGap),
                    width: sheetWidth,
                    height: sheetHeight,
                  }}
                >
                  <span className={`page-num ${corner}`}>
                    {i + 1} / {pageCount}
                  </span>
                </div>
              );
            })}
          {geometryReady && pagesPerView === 2 && (
            <div
              className="book-fold"
              style={{
                left: sheetWidth,
                width: pageGap,
                height: sheetHeight,
              }}
            />
          )}
          <div
            className="reader-clip"
            style={{
              width: Math.max(0, viewWidth),
              height: Math.max(0, sheetHeight),
            }}
          >
            {/* The drag layer carries nothing but a gesture turn's offset. It is
                a wrapper rather than a second transform on the strip because the
                strip's own transform is rewritten by every measure, restore and
                1<->2 page switch: an offset mixed into it would have to be
                re-applied by hand after each of them. */}
            <div
              className="reader-drag"
              ref={dragLayerRef}
              onTransitionEnd={(e) => {
                if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
                if (dragTurnRef.current?.settling) finishDragTurn();
              }}
            >
              <div
                className="reader-columns"
                ref={columnsRef}
                style={{
                  left: marginPx,
                  top: marginPx,
                  width: stripCols > 0 ? stripCols * contentWidth + (stripCols - 1) * columnGap : 0,
                  height: Math.max(0, contentHeight),
                  transform: `translate3d(-${pageIndex * (sheetWidth + pageGap)}px, 0, 0)`,
                  columnWidth: contentWidth,
                  columnGap: columnGap,
                }}
              >
                <div className="reader-content" ref={contentRef} style={contentStyle} />
              </div>
            </div>
            {/* The neighbouring chapter's page, one spread off-screen. Inside
                the clip, so at rest it is not on screen at all; a chapter turn
                drags it in exactly the way a page turn drags the next column
                in, and the two move on one gesture. */}
            {geometryReady && peek && (
              <TurnPeek
                key={peek.cid}
                layerRef={peekRef}
                html={peek.html}
                side={peek.side}
                contentStyle={contentStyle}
                geom={{
                  margin: marginPx,
                  contentWidth,
                  contentHeight,
                  columnGap,
                  pageStride: sheetWidth + pageGap,
                  stride: turnStep * (sheetWidth + pageGap),
                  pagesPerView,
                }}
              />
            )}
          </div>
          {/* The shadow of the turning sheet, sweeping in the direction the page
              travels. Keyed on the turn so every turn restarts the animation;
              it is a shadow over static text, so nothing has to re-layout for
              it to move. A gesture turn drives it by hand instead, matching the
              page: see placeBand. */}
          {geometryReady && (turnDrag || turnFx) && (
            <div
              key={turnDrag ? 'drag' : `sweep-${turnFx!.id}`}
              ref={veilRef}
              className={`turn-veil ${
                turnDrag
                  ? turnDrag.phase === 'follow'
                    ? 'drag'
                    : 'settle'
                  : `sweep ${turnFx!.dir > 0 ? 'fwd' : 'back'}`
              }`}
              onAnimationEnd={turnDrag ? undefined : endTurnFx}
              style={{
                width: Math.max(0, viewWidth),
                height: Math.max(0, sheetHeight),
              }}
            >
              <span className="turn-veil-band" />
            </div>
          )}
        </div>
      </div>

      {detourBar}

      {/* Phone gets its own bars (top: back/title/star; bottom: slider + tabs);
          desktop keeps the original single-row chrome with hover reveal. */}
      {touchPrimary ? (
        <>
          {mTopBar}
          {mBottomPaged}
        </>
      ) : (
        (chromeOpen || chromeHover) && (
          <>
            <div className="reader-chrome top">
              <div className="chrome-left">
                <button
                  className="btn sm"
                  onClick={() => (preview ? goUp(PREVIEW_SOURCE[preview.source].back) : goUp('/'))}
                >
                  {preview ? '← 返回' : '← 书架'}
                </button>
                <div className="crumb">
                  <strong>{book.title}</strong>
                  <span>·</span>
                  <span>{book.author || '未知作者'}</span>
                </div>
              </div>
              <div className="chrome-center" title={currentChapter?.title || undefined}>
                {currentChapter?.title || '尚未打开章节'}
              </div>
              <div className="chrome-right">
                <span className="muted" style={{ fontSize: 12 }}>
                  {Math.round(progressPct)}%
                </span>
                <button className="btn sm" onClick={() => setFontSize((f) => Math.max(13, f - 1))}>
                  A−
                </button>
                <span className="muted" style={{ fontSize: 12, minWidth: 28, textAlign: 'center' }}>
                  {fontSize}
                </span>
                <button className="btn sm" onClick={() => setFontSize((f) => Math.min(26, f + 1))}>
                  A+
                </button>
                <button
                  className="btn sm ai-guide-btn"
                  onClick={openGuide}
                  title="让 AI 读一遍本章，生成导读"
                >
                  ✦ AI 导读
                </button>
                <button className="btn sm" onClick={() => setTocOpen(true)}>
                  目录
                </button>
                <button
                  className={`btn sm dock-toggle${tocDocked ? ' primary' : ''}`}
                  onClick={() => setTocDocked((v) => !v)}
                  title={tocDocked ? '取消固定目录（恢复为抽屉）' : '将目录固定在侧边'}
                >
                  {tocDocked ? '目录已固定' : '固定目录'}
                </button>
                <button className="btn sm" onClick={() => setBmOpen(true)}>
                  书签
                </button>
                <button className="btn sm" onClick={() => setAnnOpen(true)}>
                  划线
                </button>
                <button className="btn sm" onClick={() => setMode('scroll')}>
                  滚动
                </button>
              </div>
            </div>

            <div className="reader-chrome bottom">
              <button className="btn" disabled={pageIndex <= 0 && !prev} onClick={() => turn(-1)}>
                ← 上一页
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                第 {pageIndex + 1} / {pageCount} 页
              </span>
              <button
                className="btn"
                disabled={pageIndex >= maxPageIndex && !next}
                onClick={() => turn(1)}
              >
                下一页 →
              </button>
            </div>
          </>
        )
      )}

      {/* TOC drawer */}
      {tocOpen && (
        <div className="drawer-mask" onClick={() => setTocOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              目录 · {chapters.length} 章
              <button
                className="toc-locate"
                title="定位到当前章节"
                onClick={locateCurrent}
                aria-label="定位到当前章节"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
              </button>
              <button className="btn sm" onClick={() => setTocOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {useTocTree ? (
                <TocTree
                  entries={mergedToc}
                  itemClass="drawer-item"
                  activeSet={activeSet}
                  resolve={resolveTocHref}
                  onPick={openChapter}
                  collapsed={tocCollapsed}
                  onToggle={toggleToc}
                />
              ) : (
                chapters.map((c, i) => (
                  <button
                    key={c.id}
                    className={`drawer-item${c.id === current ? ' active' : ''}`}
                    onClick={() => openChapter(c.id)}
                  >
                    <span className="num">{String(i + 1).padStart(2, '0')}</span>
                    {c.title}
                  </button>
                ))
              )}
            </div>
          </aside>
        </div>
      )}

      {/* bookmarks drawer */}
      {bmOpen && (
        <div className="drawer-mask" onClick={() => setBmOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              书签
              <button
                className={`btn sm${pageMarked ? '' : ' primary'}`}
                onClick={togglePageBookmark}
                title={pageMarked ? '取消当前页的书签' : '给当前页加一个书签'}
              >
                {pageMarked ? '移除本页书签' : '＋ 添加当前页'}
              </button>
              <button className="btn sm" onClick={() => setBmOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {bookmarks.length === 0 ? (
                <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                  还没有书签
                </div>
              ) : (
                bookmarks.map((b) => {
                  const ch = chapters.find((c) => c.id === b.chapterId);
                  return (
                    <div className="drawer-row" key={b.id}>
                      <button className="drawer-row-main" onClick={() => jumpBookmark(b)}>
                        <div className="drawer-row-title">{ch ? ch.title : '未知章节'}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {b.label ? b.label : '已标记'}
                        </div>
                      </button>
                      <button className="btn sm danger" onClick={() => removeBookmark(b.id)}>
                        删
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      )}

      {/* annotations drawer */}
      {annOpen && (
        <div className="drawer-mask" onClick={() => setAnnOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              划线 / 批注
              <button className="btn sm" onClick={() => setAnnOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {annotations.length === 0 ? (
                <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                  在正文里划选文字即可添加划线
                </div>
              ) : (
                annotations.map((a) => {
                  const ch = chapters.find((c) => c.id === a.chapterId);
                  return (
                    <div className="drawer-row" key={a.id}>
                      <button className="drawer-row-main" onClick={() => jumpAnnotation(a)}>
                        <div className="drawer-row-title">
                          <span className={`dot hl-${a.color}`} /> {ch ? ch.title : '未知章节'}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {a.text.slice(0, 40)}
                          {a.text.length > 40 ? '…' : ''}
                          {a.note ? ' · 批注: ' + a.note : ''}
                        </div>
                      </button>
                      <button className="btn sm danger" onClick={() => removeAnnotation(a.id)}>
                        删
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      )}

      {overlayLayer}
    </div>
  );
}
