import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { api, Annotation, Book, Bookmark, Chapter, LookupResult, ReadingProgress, TocEntry } from '../api';
import { Caret } from '../Caret';
import { toast, toastError } from '../toast';
import { Anchor, EDGE_GAP, placeOverlay } from '../overlay';

const FONT_KEY = 'epubmaker.fontSize';
const MODE_KEY = 'epubmaker.readMode';
const TOC_DOCK_KEY = 'epubmaker.tocDocked';
// Width of the docked TOC sidebar (kept in sync with --toc-dock-w in styles.css
// and the .toc sidebar width in scroll mode for visual consistency).
const TOC_DOCK_W = 268;

// Strip any #fragment from a TOC href so a child-section entry
// (doc.xhtml#section) resolves to its parent chapter document (doc.xhtml).
function docKey(href: string): string {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(0, i) : href;
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
          <button type="button" className="toc-caret" onClick={toggle} aria-label={open ? '折叠' : '展开'}>
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

type ReadMode = 'scroll' | 'paged';
// restore carries a layout-independent source character offset (not a page
// number), so the target page is re-derived from the current layout.
type PageIntent = { type: 'first' | 'last' | 'restore'; offset?: number } | null;

// `y`/`bottom` are the selection's viewport edges: overlays flip from one side
// of the text to the other when there is no room in their preferred direction.
type SelState = { x: number; y: number; bottom: number; start: number; end: number; text: string } | null;
type PopoverState = { x: number; y: number; ann: Annotation } | null;
// `offset`/`context` are captured at lookup time so a manual "add to notebook"
// can still record where the word came from.
type LookupCardState = {
  x: number;
  top: number;
  bottom: number;
  res: LookupResult;
  offset: number;
  context: string;
} | null;

// A visit opened from the notebook: "show me where I met this word". It is a
// detour, not reading — the position it opens at must not become the reading
// position, which is why the whole session disables progress saving.
type Detour = { word: string; surface: string; offset: number };

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
function useAnchoredOverlay(anchor: Anchor | null, prefer: 'above' | 'below', gap: number, revision: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) {
      setPos(null);
      return;
    }
    const measure = () => {
      setPos(
        placeOverlay(
          anchor,
          { width: el.offsetWidth, height: el.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          prefer,
          gap,
        ),
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
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

function charOffset(root: Node, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === node) return count + offset;
    count += (n.textContent || '').length;
  }
  return count;
}

function getSelectionOffsets(root: HTMLElement, range: Range): { start: number; end: number } | null {
  const a = charOffset(root, range.startContainer, range.startOffset);
  const b = charOffset(root, range.endContainer, range.endOffset);
  return b < a ? { start: b, end: a } : { start: a, end: b };
}

// The text node holding a character offset, with the offset inside it. Paged
// mode never needs this — it maps offsets to pages during measurement — but
// scrolling mode has no page map, so "jump back to the sentence" has to walk
// the rendered text directly.
function textNodeAt(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
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

// The sentence surrounding [start,end) in the rendered chapter text, capped so
// a paragraph-long sentence cannot bloat a notebook entry. Used as the example
// context saved alongside a looked-up word.
function sentenceAt(root: HTMLElement, start: number, end: number): string {
  const text = root.textContent || '';
  const isBreak = (c: string) => c === '.' || c === '!' || c === '?' || c === '\n';
  let s = start;
  while (s > 0 && start - s < 220 && !isBreak(text[s - 1])) s--;
  let e = end;
  while (e < text.length && e - end < 220 && !isBreak(text[e])) e++;
  return text
    .slice(s, e + 1)
    .replace(/\s+/g, ' ')
    .trim();
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
      if (a0 > p) frag.appendChild(document.createTextNode(node.textContent!.slice(p - ns, a0 - ns)));
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
  // chapter change inside the reader must not re-open a detour.
  const [detour, setDetour] = useState<Detour | null>(
    () => (loc.state as { detour?: Detour } | null)?.detour ?? null,
  );
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

  const [mode, setMode] = useState<ReadMode>(() => (localStorage.getItem(MODE_KEY) as ReadMode) || 'scroll');

  // paged reading state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pagesPerView, setPagesPerView] = useState(1);
  const [chromeOpen, setChromeOpen] = useState(false);
  const [chromeHover, setChromeHover] = useState(false);

  // page-turn cross-dissolve for CHAPTER turns: while true the whole spread is
  // faded out so a different chapter's HTML (not yet measured) can be swapped
  // with zero lateral motion.
  const [fxOut, setFxOut] = useState(false);
  const fxRef = useRef(false);
  const awaitingChapterRef = useRef(false);

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
  // Docked TOC mode: the chapter list is pinned as a persistent sidebar on the
  // left instead of opening as a transient drawer.
  const [tocDocked, setTocDocked] = useState(() => localStorage.getItem(TOC_DOCK_KEY) === '1');
  const [bmOpen, setBmOpen] = useState(false);
  const [annOpen, setAnnOpen] = useState(false);
  const [sel, setSel] = useState<SelState>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [noteDraft, setNoteDraft] = useState('');

  // Dictionary card for a word picked out of the page. It is positioned in
  // viewport coordinates and rendered outside the page flow on purpose: this
  // reader paginates by measuring content height, so anything joining the flow
  // would change the page count and throw the reader off their page.
  const [lookupCard, setLookupCard] = useState<LookupCardState>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  // A jump from the notebook or an annotation list has to be visible, not just
  // correct: this is a transient highlight over the landed-on text.
  const [flash, setFlash] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // Overlay placement: the selection toolbar prefers the space above the text,
  // the dictionary card and annotation popover the space below. Each flips to
  // the other side when its preferred direction has no room, and all three are
  // clamped sideways, so a word picked at the margin of the window no longer
  // pushes its card partly off screen.
  const selPos = useAnchoredOverlay(sel && { x: sel.x, top: sel.y, bottom: sel.bottom }, 'above', EDGE_GAP, sel?.start);
  const dictPos = useAnchoredOverlay(
    lookupCard && { x: lookupCard.x, top: lookupCard.top, bottom: lookupCard.bottom },
    'below',
    14,
    `${lookupCard?.res.found}-${lookupCard?.res.recorded}`,
  );
  const popPos = useAnchoredOverlay(popover && { x: popover.x, top: popover.y, bottom: popover.y }, 'below', 0, popover?.ann.id);

  const mainRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageIntentRef = useRef<PageIntent>(null);
  // Layout-independent restore target: a source character offset to land on.
  // Kept in a ref (not a one-shot intent) so it survives across measure passes
  // — e.g. when the first measurement happens before the stage is laid out.
  const restoreOffsetRef = useRef<number | null>(null);
  const locationUsedRef = useRef(false);
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
        // Kept so a detour can offer "back to where I actually was".
        setOrigin(prog);

        const exists = (cid: string | undefined) => !!cid && cs.some((c) => c.id === cid);
        const target =
          (chapterId && exists(chapterId) && chapterId) ||
          (prog && exists(prog.chapterId) && prog.chapterId) ||
          cs[0]?.id ||
          null;
        if (prog && prog.chapterId === target && prog.positionOffset > 0) {
          restoreOffsetRef.current = prog.positionOffset;
        }
        const restoreOffset = (loc.state as { offset?: number } | null)?.offset;
        if (restoreOffset !== undefined && !locationUsedRef.current) {
          restoreOffsetRef.current = restoreOffset;
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

  /* ---- render current chapter HTML ---- */
  useEffect(() => {
    if (!current) return;
    // A detour from the notebook never writes progress: the reader is here to
    // look at one word, and opening the book again should return them to where
    // they were actually reading.
    if (mode === 'scroll' && !detour) {
      localStorage.setItem(posKey(id), current);
      // Writing the chapter start here would clobber the position that is about
      // to be restored a moment later, so it only happens when there is nothing
      // to restore and the pane really is at the top.
      if (restoreOffsetRef.current === null) api.saveProgress(id, current, 0, 1).catch(() => {});
    }
    (async () => {
      try {
        const r = await api.renderChapter(id, current);
        setHtml(r.html);
        if (mode === 'scroll') mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      } catch (e) {
        toastError(e);
        setHtml('<p class="muted">章节内容读取失败</p>');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, current]);

  useEffect(() => localStorage.setItem(FONT_KEY, String(fontSize)), [fontSize]);
  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode]);
  useEffect(() => localStorage.setItem(TOC_DOCK_KEY, tocDocked ? '1' : '0'), [tocDocked]);

  // When the docked sidebar is toggled, the available reading width changes, so
  // re-measure the page geometry (the page size / 1-vs-2 spread must adapt).
  useEffect(() => {
    if (mode !== 'paged') return;
    scheduleMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocDocked, mode]);

  const safeHtml = useMemo(
    () => DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['script', 'style', 'link'] }),
    [html]
  );

  const annotationsForChapter = useMemo(
    () => annotations.filter((a) => a.chapterId === current),
    [annotations, current]
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
    // The word you came here for keeps its highlight, so a fading flash on top
    // of it would only repeat itself.
    if (detour) return;
    // Landing counts as a position: record it, otherwise a reader who jumps
    // back and leaves immediately would find the old anchor next time.
    if (current) api.saveProgress(id, current, target, 1).catch(() => {});
    setFlash({ left: after.left - 2, top: after.top - 3, width: Math.max(after.width, 6), height: after.height + 6 });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(timer);
  }, [safeHtml, mode, detour]);

  // The word a notebook jump points at stays lit for as long as you are on the
  // page. A 1.4s flash is enough to find a bookmark; it is not enough to study
  // a word, and this visit exists precisely to look at the word in context.
  useEffect(() => {
    if (mode !== 'scroll' || !detour) return;
    const el = contentRef.current;
    if (!el || el.querySelector('mark.hl-vocab')) return;
    const r = wordRangeAt(el, detour.offset, [detour.surface, detour.word]);
    if (!r) return;
    applyHighlights(el, [{ id: ANCHOR_ID, startOffset: r.start, endOffset: r.end, color: 'vocab' }]);
  }, [safeHtml, mode, detour]);

  /* ---- imperatively set content + highlights (paged mode) ---- */
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || mode !== 'paged') return;
    el.innerHTML = safeHtml;
    // The detour word is wrapped exactly like a highlight, so it survives page
    // turns: the markup lives in the chapter, not in a floating layer.
    const anchor = detour ? wordRangeAt(el, detour.offset, [detour.surface, detour.word]) : null;
    applyHighlights(
      el,
      anchor
        ? [...annotationsForChapter, { id: ANCHOR_ID, startOffset: anchor.start, endOffset: anchor.end, color: 'vocab' }]
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
  }, [safeHtml, annotationsForChapter, mode, detour]);

  /* ---- measure pages (paged mode) ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      // Snapshot the window size synchronously so measureAndLayout reads a
      // fresh value even if the inner element's clientWidth lags the resize.
      winSizeRef.current = { w: window.innerWidth, h: window.innerHeight };
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
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    window.addEventListener('resize', update);
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useLayoutEffect(() => {
    if (mode !== 'paged') return;
    measureAndLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, fontSize, mode, stageWidth, stageHeight]);

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
      const r = range.getBoundingClientRect();
      if (r.width > 0) {
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
    const map = offsetMapRef.current;
    if (map.length === 0) return 0;
    for (const s of map) {
      if (s.page >= p) return s.offset;
    }
    return map[map.length - 1].offset;
  }

  function measureAndLayout() {
    const stage = stageRef.current;
    const col = columnsRef.current;
    if (!col) return;

    const MARGIN = 34;
    const GAP = 14;
    const OUTER_PAD_X = 44;
    const OUTER_PAD_Y = 22;
    const MIN_PAGE_W = 260;
    const PAGE_RATIO = 0.72; // typical Chinese paperback width/height
    const BASE_H = 1000;
    const BASE_W = BASE_H * PAGE_RATIO;

    // Drive geometry off the (always-current) window size, NOT an element's
    // clientWidth — see winSizeRef for why this matters under Wails.
    const ws = winSizeRef.current;
    const W = ws.w || (stage ? stage.clientWidth : 1280);
    const H = ws.h || (stage ? stage.clientHeight : 800);
    // The docked TOC sidebar eats horizontal space on the left, so the usable
    // reading width is the window minus the dock. This keeps the book fully
    // visible inside the shrunken stage instead of being clipped by it.
    const dockW = tocDockedRef.current ? TOC_DOCK_W : 0;
    const effW = Math.max(0, W - dockW);
    const availW = Math.max(320, effW - OUTER_PAD_X * 2);
    const availH = Math.max(260, H - OUTER_PAD_Y * 2);

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
    const ppv = effW >= 900 && doubleW >= MIN_PAGE_W ? 2 : 1;
    const sw = ppv === 2 ? doubleW : singleW;
    const sh = ppv === 2 ? doubleH : singleH;
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
    const pc = Math.max(1, Math.ceil(col.scrollWidth / (cw + columnGap)));
    setPageCount(pc);
    col.style.width = `${pc * cw + (pc - 1) * columnGap}px`;

    // Build the layout-independent offset->page map BEFORE deriving any page,
    // using the geometry we just measured (cw/ch are the local, correct values
    // — reading them from React state here could be stale within this pass).
    buildOffsetMap(stride);

    // Capture the source offset of the currently shown page so a layout change
    // (font size / window / DPI) keeps the same text in view instead of the
    // same (now wrong) page number.
    const keepOffset = offsetForPage(pageIndex);

    const maxIdx = Math.max(0, pc - ppv);
    const intent = pageIntentRef.current;
    let nextPage = 0;

    if (restoreOffsetRef.current !== null && offsetMapRef.current.length > 0) {
      // Explicit restore (bookmark / annotation / saved progress): land on the
      // page that currently holds this source offset regardless of layout.
      nextPage = Math.min(pageIndexForOffset(restoreOffsetRef.current), maxIdx);
      restoreOffsetRef.current = null;
    } else if (intent?.type === 'last') {
      // Chapter switch backwards: open the previous chapter on its last page.
      nextPage = maxIdx;
    } else if (intent?.type === 'first') {
      // Chapter switch forwards (or TOC jump): open on the first page.
      nextPage = 0;
    } else if (keepOffset !== undefined) {
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
    pageIntentRef.current = null;

    // A cross-chapter turn was faded out and is still waiting (see startTurn).
    // Fade the spread back in ONLY after this measurement has committed the new
    // chapter's page count and starting page. If we faded in on the safeHtml
    // change instead, the spread would fade in while pageIndex still pointed at
    // the OLD chapter, and the index jump on the next frame reads as a visible
    // "jolt". Deferring one frame guarantees the freshly measured page is
    // already painted underneath before it becomes visible.
    if (awaitingChapterRef.current) {
      awaitingChapterRef.current = false;
      requestAnimationFrame(() => {
        setFxOut(false);
        fxRef.current = false;
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
    const top = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'auto' });

    // Measured again after scrolling so the caller's highlight lands on the
    // right line rather than where the text used to be.
    return range.getBoundingClientRect();
  }

  function flashAt(box: { left: number; top: number; width: number; height: number }) {
    setFlash({ left: box.left - 2, top: box.top - 3, width: Math.max(box.width, 6), height: box.height + 6 });
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
    if (caret && caret.startContainer.nodeType === Node.TEXT_NODE && root.contains(caret.startContainer)) {
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
    if (mode !== 'paged' || !current || detour) return;
    const t = setTimeout(() => {
      const off = offsetForPage(pageIndex);
      api.saveProgress(id, current, off, pageCount).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [mode, current, pageIndex, pageCount, id, detour]);

  /* ---- progress persistence (scrolling mode) ---- */
  useEffect(() => {
    if (mode !== 'scroll' || !current || detour) return;
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
  }, [mode, current, id, detour, safeHtml]);

  const idx = chapters.findIndex((c) => c.id === current);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  const progressPct = chapters.length
    ? ((idx + (pageCount ? pageIndex / pageCount : 0)) / chapters.length) * 100
    : 0;

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
  const currentChapter = current ? chapters.find((c) => c.id === current) ?? null : null;
  const activeDoc = currentChapter?.href ?? null;
  // Active highlight for the hierarchical TOC (no-op for flat-legacy books).
  const activeSet = useMemo(
    () => (activeDoc ? computeActiveHrefs(toc, activeDoc) : new Set<string>()),
    [toc, activeDoc],
  );

  // Expand every ancestor group of the current chapter and (after render) scroll
  // the active node into view. If no TOC surface is showing, open the drawer.
  function locateCurrent() {
    if (!activeDoc) return;
    const path = findTocPath(toc, docKey(activeDoc));
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
    setPopover(null);
    setSel(null);
    setBmOpen(false);
    setTocOpen(false);
    if (intent?.type === 'restore') {
      restoreOffsetRef.current = intent.offset ?? 0;
    } else if (intent?.type === 'last') {
      pageIntentRef.current = { type: 'last' };
    } else {
      pageIntentRef.current = { type: 'first' };
    }
    if (cid === current) {
      // Same chapter: setCurrent is a no-op, so force a re-measure to apply the
      // intent/restore right now (otherwise it would never be consumed).
      scheduleMeasure();
    }
    setCurrent(cid);
  }

  const turnStep = Math.max(1, pagesPerView);
  const maxPageIndex = Math.max(0, pageCount - pagesPerView);

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

  function turn(delta: number) {
    const step = turnStep;
    if (delta > 0) {
      if (pageIndex + step <= maxPageIndex) setPageIndex(pageIndex + step);
      else if (next) startTurn(() => openChapter(next.id, { type: 'first' }));
    } else {
      if (pageIndex - step >= 0) setPageIndex(pageIndex - step);
      else if (prev) startTurn(() => openChapter(prev.id, { type: 'last' }));
    }
  }

  /* keep the current view inside the book when switching 1<->2 page mode */
  useEffect(() => {
    if (mode !== 'paged') return;
    if (pageIndex > maxPageIndex) setPageIndex(maxPageIndex);
  }, [mode, pageCount, pagesPerView]);

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

    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;

    // Fixed zones: narrow edges turn pages, small center toggles chrome,
    // the broad middle band is left for text selection / links.
    if (ratio < 0.18) turn(-1);
    else if (ratio > 0.82) turn(1);
    else if (ratio > 0.42 && ratio < 0.58) setChromeOpen((o) => !o);
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

  /* ---- detour (opened from the notebook) ---- */
  // Adopts the detour position as the reading position. Deliberately explicit:
  // it is the only way a notebook visit is allowed to overwrite progress.
  function resumeFromDetour() {
    setDetour(null);
    if (!current) return;
    const off = mode === 'paged' ? offsetForPage(pageIndex) : offsetAtViewportTop();
    api.saveProgress(id, current, off, mode === 'paged' ? pageCount : 1).catch(() => {});
    toast('已从当前位置继续阅读', 'success');
  }

  // Goes back to where the reader actually was. The detour ends here: they are
  // standing on their own reading position again, so saving progress from now
  // on records the same place rather than a place they never chose.
  function backToLastReading() {
    if (!origin || !origin.chapterId) return;
    setDetour(null);
    if (origin.chapterId !== current) {
      openChapter(origin.chapterId, { type: 'restore', offset: origin.positionOffset });
      return;
    }
    if (mode === 'paged') {
      restoreOffsetRef.current = origin.positionOffset;
      scheduleMeasure();
      return;
    }
    const box = scrollTextTo(origin.positionOffset);
    if (box) flashAt(box);
  }

  /* ---- keyboard ---- */
  function exitReading() {
    // Leaving a detour returns to the notebook and leaves the reading position
    // alone — that is the whole point of the visit.
    if (detour) {
      nav('/vocab');
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
    nav('/');
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Backspace exits the reader.
      if (e.key === 'Backspace') {
        e.preventDefault();
        exitReading();
        return;
      }

      if (e.key === 'Escape') {
        // Close any open overlay first; otherwise exit the reader.
        if (popover) { setPopover(null); return; }
        if (sel) { setSel(null); return; }
        if (bmOpen) { setBmOpen(false); return; }
        if (annOpen) { setAnnOpen(false); return; }
        if (tocOpen) { setTocOpen(false); return; }
        if (chromeOpen) { setChromeOpen(false); return; }
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
  }, [mode, prev, next, pageIndex, pageCount, chromeOpen, popover, sel, bmOpen, annOpen, tocOpen, current, id, detour]);

  /* ---- hover the top/bottom edge to reveal the reader chrome (paged) ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
    // During a notebook detour the banner floats along the bottom edge, and a
    // chrome bar sliding out under the pointer would cover the very buttons the
    // reader is reaching for. The bars stay reachable: Enter, or a click in the
    // middle of the page.
    if (detour) {
      setChromeHover(false);
      return;
    }
    const EDGE = 64; // px from the top/bottom edge that activates the chrome
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf) return; // coalesce bursts of mousemove into one frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = e.clientY;
        const h = window.innerHeight;
        const near = y < EDGE || y > h - EDGE;
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
  }, [mode, detour]);

  /* ---- selection -> toolbar (both modes) ---- */
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const root = el;
    function onMouseUp() {
      // Any new interaction in the text dismisses the previous dictionary card.
      setLookupCard(null);
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
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
      setSel({
        x: rect.left + rect.width / 2,
        y: rect.top,
        bottom: rect.bottom,
        start: offs.start,
        end: offs.end,
        text: selection.toString(),
      });
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
      }
    }
    root.addEventListener('mouseup', onMouseUp);
    root.addEventListener('click', onClick);
    return () => {
      root.removeEventListener('mouseup', onMouseUp);
      root.removeEventListener('click', onClick);
    };
    // `html` is a dependency because on a cold open the content node does not
    // exist yet when this effect first runs — without it the listeners would
    // never attach and selecting text would do nothing.
  }, [mode, annotations, html]);

  /* ---- dictionary / vocabulary ---- */

  async function lookupSelection() {
    if (!sel || !current) return;
    const word = sel.text.trim();
    if (!word) return;
    const root = contentRef.current;
    const context = root ? sentenceAt(root, sel.start, sel.end) : '';
    const at = { x: sel.x, top: sel.y, bottom: sel.bottom };
    const offset = sel.start;
    setSel(null);
    setLookupBusy(true);
    try {
      const res = await api.lookupWord(id, current, offset, word, context);
      setLookupCard({ ...at, res, offset, context });
    } catch (e) {
      toastError(e);
    } finally {
      setLookupBusy(false);
    }
  }

  // Pronunciation via the WebView's built-in speech synthesis: no network, no
  // bundled audio, works offline.
  function speak(text: string) {
    if (!text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      /* speech synthesis unavailable in this WebView */
    }
  }

  async function addCardToNotebook() {
    if (!lookupCard) return;
    const { res, offset, context } = lookupCard;
    const entry = res.entry;
    if (!entry) return;
    try {
      const v = await api.vocabAdd(entry.word, res.query || entry.word, id, current || '', offset, context);
      setLookupCard({ ...lookupCard, res: { ...res, recorded: true, vocabId: v.id } });
      toast('已加入生词本', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  /* ---- annotation / bookmark actions ---- */
  async function createAnnotation(color: string) {
    if (!sel || !current) return;
    try {
      const a = await api.addAnnotation(id, current, sel.start, sel.end, pageIndex, sel.text, color, '');
      setAnnotations((prev) => [...prev, a]);
      window.getSelection()?.removeAllRanges();
      setSel(null);
      toast('已划线', 'success');
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
      const off = offsetForPage(pageIndex);
      const b = await api.addBookmark(id, current, off, '');
      setBookmarks((prev) => [...prev, b]);
      toast('已添加书签', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  async function removeBookmark(bid: string) {
    try {
      await api.deleteBookmark(bid);
      setBookmarks((prev) => prev.filter((x) => x.id !== bid));
    } catch (e) {
      toastError(e);
    }
  }

  function jumpBookmark(b: Bookmark) {
    openChapter(b.chapterId, { type: 'restore', offset: b.anchor });
  }

  function jumpAnnotation(a: Annotation) {
    openChapter(a.chapterId, { type: 'restore', offset: a.startOffset });
    setAnnOpen(false);
  }

  /* ---- render ---- */
  if (loading) return <div className="loading">加载中…</div>;
  if (!book) return <div className="page empty">书籍不存在</div>;

  // Overlays live outside both reading layouts: they are viewport-anchored, and
  // keeping one copy is what makes "select a word, look it up" work while
  // scrolling as well as while paging.
  const overlayLayer = (
    <>
      {/* selection toolbar */}
      {sel && (
        <div className="sel-toolbar" ref={selPos.ref} style={overlayStyle(selPos.pos)}>
          <button className="sel-lookup" title="查词" onClick={lookupSelection} disabled={lookupBusy}>
            {lookupBusy ? '查询中' : '查词'}
          </button>
          {/* Highlights are painted by the paginated view only, so offering
              colours while scrolling would promise something invisible. */}
          {mode === 'paged' &&
            COLORS.map((c) => (
              <button key={c} className={`swatch sw-${c}`} title={c} onClick={() => createAnnotation(c)} />
            ))}
        </div>
      )}

      {/* dictionary card — fixed layer, never part of the page layout */}
      {lookupCard && (
        <div className="dict-card" ref={dictPos.ref} style={overlayStyle(dictPos.pos)}>
          <button className="dict-close" title="关闭" onClick={() => setLookupCard(null)}>
            ×
          </button>
          {!lookupCard.res.found || !lookupCard.res.entry ? (
            <div className="dict-miss">
              词库未收录 <b>{lookupCard.res.query}</b>
            </div>
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
                  onClick={() => speak(lookupCard.res.entry?.word || '')}
                >
                  发音
                </button>
              </div>
              {lookupCard.res.entry.translation ? (
                <div className="dict-trans">{lookupCard.res.entry.translation}</div>
              ) : (
                <div className="dict-trans muted">{lookupCard.res.entry.definition || '暂无释义'}</div>
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
              </div>
            </>
          )}
        </div>
      )}

      {/* annotation popover */}
      {popover && (
        <div className="ann-popover" ref={popPos.ref} style={overlayStyle(popPos.pos)}>
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
    </>
  );

  // The banner that explains a detour and offers the two ways out of it. It is
  // the only place in the reader that admits it is not a normal visit.
  //
  // Floating above the page it sits clear of the bottom chrome instead of under
  // it, so the buttons never end up behind a bar that appears on approach.
  const detourBar = detour ? (
    <div
      className={`detour-bar${mode === 'paged' ? ' floating' : ''}`}
      style={mode === 'paged' && chromeOpen ? { bottom: 58 } : undefined}
    >
      <span className="detour-word">{detour.word}</span>
      <span className="detour-hint">生词本跳转 · 临时查看，不记录阅读进度</span>
      <span className="detour-gap" />
      <button
        className="btn sm"
        disabled={!origin}
        onClick={backToLastReading}
        title={origin ? '回到上次读到的地方' : '这本书还没有阅读记录'}
      >
        回到上次阅读
      </button>
      <button className="btn sm" onClick={resumeFromDetour} title="把当前位置记为阅读进度，正常往下读">
        从此处继续读
      </button>
      <button className="btn sm" onClick={() => nav('/vocab')}>
        返回生词本
      </button>
    </div>
  ) : null;

  if (mode === 'scroll') {
    return (
      <div className="reader">
        <aside className="toc">
          <div className="toc-head">
            目录 · {chapters.length} 章
            <button className="toc-locate" title="定位到当前章节" onClick={locateCurrent} aria-label="定位到当前章节">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
            </button>
          </div>
          {toc.length > 0 ? (
            <TocTree entries={toc} itemClass="toc-item" activeSet={activeSet} resolve={resolveTocHref} onPick={openChapter} collapsed={tocCollapsed} onToggle={toggleToc} />
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
              <Link className="btn sm" to={`/books/${id}/edit`}>
                整理
              </Link>
              <button className="btn sm" onClick={() => nav(detour ? '/vocab' : '/')}>
                {detour ? '生词本' : '书架'}
              </button>
            </div>
          </div>

          <article className="reader-paper">
            <div
              className="reader-content"
              ref={contentRef}
              style={{ fontSize }}
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
      </div>
    );
  }

  /* ---- paged immersive mode ---- */
  const viewWidth = pagesPerView * sheetWidth + (pagesPerView - 1) * pageGap;
  const columnGap = sheetWidth + pageGap - contentWidth;
  const geometryReady = sheetWidth > 0 && contentWidth > 0;
  // Covered page-edge thickness: how much of the "next/previous pages" stack
  // peeks out beyond the current sheet, and how much tucks under it.
  const bookEdgeW = 30;
  const bookEdgeTuck = 8;
  const bookEdgeVisible = bookEdgeW - bookEdgeTuck;
  // Only render the sheets actually on screen (1 or 2) so no third-page edge leaks.
  const visibleSheets = geometryReady ? Math.min(pagesPerView, Math.max(0, pageCount - pageIndex)) : 0;

  return (
    <div className={"reader reader-paged" + (tocDocked ? " toc-docked" : "")}>
      {tocDocked && (
        <aside className="toc-dock">
          <div className="toc-head">
            目录 · {chapters.length} 章
            <button className="toc-locate" title="定位到当前章节" onClick={locateCurrent} aria-label="定位到当前章节">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
            </button>
            <button className="btn sm" onClick={() => setTocDocked(false)} title="取消固定目录">
              ✕
            </button>
          </div>
          <div className="toc-dock-body">
            {toc.length > 0 ? (
              <TocTree entries={toc} itemClass="toc-item" activeSet={activeSet} resolve={resolveTocHref} onPick={openChapter} collapsed={tocCollapsed} onToggle={toggleToc} />
            ) : (
              chapters.map((c, i) => (
                <button
                  key={c.id}
                  className={`toc-item${c.id === current ? " active" : ""}`}
                  onClick={() => openChapter(c.id)}
                  title={c.title}
                >
                  <span className="num">{String(i + 1).padStart(2, "0")}</span>
                  {c.title}
                </button>
              ))
            )}
          </div>
        </aside>
      )}
      <div className="reader-stage" ref={stageRef} onClick={onStageClick}>
        <div
          className={`reader-spread${fxOut ? ' fx-out' : ''}`}
          ref={spreadRef}
          style={{
            width: Math.max(0, viewWidth),
            height: Math.max(0, sheetHeight),
          }}
        >
          {/* Covered page edges: the rest of the book peeking out from behind the
              current sheet(s), so it reads like an open book. Shown only when there
              are actually pages on that side. */}
          {geometryReady && (
            <>
              <div
                className="book-edge left"
                style={{ left: -bookEdgeVisible, width: bookEdgeW, height: sheetHeight }}
              />
              <div
                className="book-edge right"
                style={{ left: viewWidth - bookEdgeTuck, width: bookEdgeW, height: sheetHeight }}
              />
            </>
          )}
          {geometryReady &&
            Array.from({ length: visibleSheets }).map((_, j) => {
              const i = pageIndex + j;
              const isLeft = i % 2 === 0;
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
                  <span className={`page-num ${corner}`}>{i + 1} / {pageCount}</span>
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
            <div
              className="reader-columns"
              ref={columnsRef}
              style={{
                left: marginPx,
                top: marginPx,
                width: pageCount > 0 ? pageCount * contentWidth + (pageCount - 1) * columnGap : 0,
                height: Math.max(0, contentHeight),
                transform: `translate3d(-${pageIndex * (sheetWidth + pageGap)}px, 0, 0)`,
                columnWidth: contentWidth,
                columnGap: columnGap,
              }}
            >
              <div className="reader-content" ref={contentRef} style={{ fontSize }} />
            </div>
          </div>
        </div>
      </div>

      {detourBar}

      {(chromeOpen || chromeHover) && (
        <>
          <div className="reader-chrome top">
            <div className="chrome-left">
              <button className="btn sm" onClick={() => nav(detour ? '/vocab' : '/')}>
                {detour ? '← 生词本' : '← 书架'}
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
            <button className="btn sm" onClick={() => setTocOpen(true)}>
              目录
            </button>
            <button
              className={`btn sm${tocDocked ? ' primary' : ''}`}
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
            <button className="btn" disabled={pageIndex >= maxPageIndex && !next} onClick={() => turn(1)}>
              下一页 →
            </button>
          </div>
        </>
      )}

      {/* TOC drawer */}
      {tocOpen && (
        <div className="drawer-mask" onClick={() => setTocOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              目录 · {chapters.length} 章
              <button className="toc-locate" title="定位到当前章节" onClick={locateCurrent} aria-label="定位到当前章节">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
              </button>
              <button className="btn sm" onClick={() => setTocOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {toc.length > 0 ? (
                <TocTree entries={toc} itemClass="drawer-item" activeSet={activeSet} resolve={resolveTocHref} onPick={openChapter} collapsed={tocCollapsed} onToggle={toggleToc} />
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
              <button className="btn sm primary" onClick={addBookmarkNow}>
                ＋ 添加当前页
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
