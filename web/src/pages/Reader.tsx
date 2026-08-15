import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { api, Annotation, Book, Bookmark, Chapter, TocEntry } from '../api';
import { Caret } from '../Caret';
import { toast, toastError } from '../toast';

const FONT_KEY = 'epubmaker.fontSize';
const MODE_KEY = 'epubmaker.readMode';
const TOC_DOCK_KEY = 'epubmaker.tocDocked';
const FLIP_STYLE_KEY = 'epubmaker.flipStyle';
const FLIP_DUR_KEY = 'epubmaker.flipDuration';
const FLIP_CURL_KEY = 'epubmaker.flipCurl';
const FLIP_ENABLED_KEY = 'epubmaker.flipEnabled';
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

type SelState = { x: number; y: number; start: number; end: number; text: string } | null;
type PopoverState = { x: number; y: number; ann: Annotation } | null;

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

// Wraps the character ranges of each annotation in <mark> elements. Operates on
// the raw text nodes of `root` (run after innerHTML is set, before any mutation).
function applyHighlights(root: HTMLElement, anns: Annotation[]) {
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

  // Flip look preferences (persisted). style: "real" 3D page-turn vs "fade"
  // soft dissolve. duration in ms; curl 0..100 controls the paper sheen/shadow.
  const [flipStyle, setFlipStyle] = useState<'real' | 'fade'>(
    () => (localStorage.getItem(FLIP_STYLE_KEY) as 'real' | 'fade') || 'real',
  );
  const [flipDuration, setFlipDuration] = useState<number>(
    () => Number(localStorage.getItem(FLIP_DUR_KEY)) || 460,
  );
  const [flipCurl, setFlipCurl] = useState<number>(
    () => Number(localStorage.getItem(FLIP_CURL_KEY)) || 55,
  );
  const [flipEnabled, setFlipEnabled] = useState<boolean>(
    () => localStorage.getItem(FLIP_ENABLED_KEY) !== '0',
  );
  const [flipSettingsOpen, setFlipSettingsOpen] = useState(false);

  // Within-chapter page turn (the 3D flip). The turning sheet is an absolutely
  // positioned overlay that mirrors the live multi-column content; the static
  // page underneath never re-lays-out during the turn. Two looks are supported:
  //  - "real": the sheet rotates around the spine (0→180°); its BACK carries the
  //    NEW page, so once flipped the new content is already in place with no
  //    mid-turn blank (the page index is swapped only at the very end).
  //  - "fade": the sheet (old page only) fades out over the first half; the
  //    underlying page is silently swapped at the midpoint.
  // Only the turning page animates: the RIGHT page for next, the LEFT for prev in
  // two-page mode (the single page in single mode) — identical feel in both
  // layouts. Progress is written per-frame straight to DOM styles via refs (no
  // React re-render per frame); the index swaps at the midpoint (fade) or end (real).
  type FlipStyle = 'real' | 'fade';
  type FlipState = { dir: 1 | -1; from: number; to: number };
  const [flip, setFlip] = useState<FlipState | null>(null);
  const turnerRef = useRef<HTMLDivElement>(null);
  const flipFrontRef = useRef<HTMLDivElement>(null);
  const flipBackRef = useRef<HTMLDivElement>(null);
  const flipSheenRef = useRef<HTMLDivElement>(null);
  const flipCurlRef = useRef<HTMLDivElement>(null);
  const flipCastRef = useRef<HTMLDivElement>(null);
  const flipStartRef = useRef(0);
  const flipSwappedRef = useRef(false);

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
    if (mode === 'scroll') {
      localStorage.setItem(posKey(id), current);
      api.saveProgress(id, current, 0, 1).catch(() => {});
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
  useEffect(() => localStorage.setItem(FLIP_STYLE_KEY, flipStyle), [flipStyle]);
  useEffect(() => localStorage.setItem(FLIP_DUR_KEY, String(flipDuration)), [flipDuration]);
  useEffect(() => localStorage.setItem(FLIP_CURL_KEY, String(flipCurl)), [flipCurl]);
  useEffect(() => localStorage.setItem(FLIP_ENABLED_KEY, flipEnabled ? '1' : '0'), [flipEnabled]);

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

  /* ---- imperatively set content + highlights (paged mode) ---- */
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || mode !== 'paged') return;
    el.innerHTML = safeHtml;
    applyHighlights(el, annotationsForChapter);
    el.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', scheduleMeasure, { once: true });
        img.addEventListener('error', scheduleMeasure, { once: true });
      }
    });
    scheduleMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeHtml, annotationsForChapter, mode]);

  /* ---- populate the turning sheet's two faces (only while a flip is in flight) ---- */
  useEffect(() => {
    if (!flip) return;
    for (const ref of [flipFrontRef, flipBackRef]) {
      const el = ref.current?.querySelector<HTMLElement>('.reader-content');
      if (!el) continue;
      el.innerHTML = safeHtml;
      applyHighlights(el, annotationsForChapter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip, safeHtml, annotationsForChapter]);

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

  /* ---- progress persistence (paged mode) ---- */
  useEffect(() => {
    if (mode !== 'paged' || !current) return;
    const t = setTimeout(() => {
      const off = offsetForPage(pageIndex);
      api.saveProgress(id, current, off, pageCount).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [mode, current, pageIndex, pageCount, id]);

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
  // next/previous chapter) while invisible, then fade back in. This removes the
  // horizontal carousel slide entirely — there is zero lateral motion, and a
  // chapter change becomes a clean dissolve rather than a long slide-to-the-end.
  // Used for chapter turns (different HTML not yet measured); within-chapter
  // turns use the 3D flip below instead.
  function startTurn(apply: () => void, isChapter = false) {
    if (fxRef.current) return;
    // When the flip animation is turned off, chapter turns should be just as
    // instant as within-chapter turns (a direct content swap, no fade flash).
    if (!flipEnabled) {
      apply();
      return;
    }
    fxRef.current = true;
    if (isChapter) awaitingChapterRef.current = true;
    setFxOut(true);
    window.setTimeout(() => {
      apply();
      if (!isChapter) {
        setFxOut(false);
        fxRef.current = false;
      }
    }, 130);
  }

  // Within-chapter page turn: kicking the flip state mounts the turning sheet
  // and starts the rAF effect below. That effect lifts the sheet from its
  // bottom corner and fades it out over the FIRST HALF of the turn, then swaps
  // the page index at the exact midpoint — so the new content is already in
  // place when the sheet has fully vanished (the "page middle" of the model).
  function flipTo(to: number, dir: 1 | -1) {
    if (flip || fxRef.current) return;
    if (!flipEnabled) {
      setPageIndex(to);
      return;
    }
    setFlip({ dir, from: pageIndex, to });
  }

  // Drive the turn with requestAnimationFrame — robustness over a CSS keyframe
  // (the WebView doesn't always fire CSS animations). Progress t runs 0..1 over
  // flipDuration. The turning sheet is a single plane that rotates around the
  // spine (0→±180°); its BACK face carries the new page, so at the end of a
  // "real" turn the new content is already shown with no blank mid-turn. A "fade"
  // turn keeps the front (old page) only and fades the whole sheet out over the
  // first half, while the underlying page is silently swapped at the midpoint.
  // Curl sheen + shadow sweep across the sheet for paper realism. The index swap
  // happens at the end (real) or midpoint (fade) so the static page never jumps.
  useEffect(() => {
    if (!flip) return;
    flipStartRef.current = performance.now();
    flipSwappedRef.current = false;
    const twoPage = pagesPerView === 2;
    const dir = flip.dir;
    let pivotLeft: boolean;
    let startA: number;
    let endA: number;
    if (twoPage) {
      if (dir > 0) {
        pivotLeft = true;
        startA = 0;
        endA = -180;
      } else {
        pivotLeft = false;
        startA = 0;
        endA = 180;
      }
    } else {
      if (dir > 0) {
        pivotLeft = true;
        startA = 0;
        endA = -180;
      } else {
        pivotLeft = true;
        startA = -180;
        endA = 0;
      }
    }
    const swapAt = flipStyle === 'real' ? 1 : 0.5;
    const curlAmt = Math.max(0, Math.min(1, flipCurl / 100));
    const turner = turnerRef.current;
    const sheen = flipSheenRef.current;
    const curl = flipCurlRef.current;
    const cast = flipCastRef.current;
    // Shadow cast onto the page the turning sheet lifts off of.
    if (cast) {
      cast.style.background = twoPage
        ? dir > 0
          ? 'linear-gradient(90deg, rgba(0,0,0,.38), rgba(0,0,0,0) 70%)'
          : 'linear-gradient(270deg, rgba(0,0,0,.38), rgba(0,0,0,0) 70%)'
        : 'linear-gradient(90deg, rgba(0,0,0,.30) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0) 65%, rgba(0,0,0,.30) 100%)';
    }
    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const smooth = (a: number, b: number, t: number) => {
      t = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - flipStartRef.current) / Math.max(1, flipDuration));
      const e = easeInOut(t);
      const ang = startA + (endA - startA) * e;
      if (turner) {
        turner.style.transformOrigin = pivotLeft ? 'left center' : 'right center';
        turner.style.transform = `translateZ(1px) rotateY(${ang}deg)`;
      }
      // Curl sheen + shadow sweep with the turn (peak at the middle).
      const sweep = Math.sin(e * Math.PI);
      const op = sweep * curlAmt;
      if (sheen) {
        sheen.style.opacity = String(op * 0.9);
        const pos = dir > 0 ? 10 + e * 70 : 80 - e * 70;
        sheen.style.background = `linear-gradient(115deg, rgba(255,255,255,0) ${pos - 14}%, rgba(255,255,255,.55) ${pos}%, rgba(255,255,255,0) ${pos + 14}%)`;
      }
      if (curl) {
        curl.style.opacity = String(op);
        const pos = dir > 0 ? 10 + e * 70 : 80 - e * 70;
        curl.style.background = `linear-gradient(115deg, rgba(0,0,0,0) ${pos - 16}%, rgba(0,0,0,.28) ${pos}%, rgba(0,0,0,0) ${pos + 16}%)`;
      }
      if (cast) cast.style.opacity = String(sweep * 0.5);
      // Fade look: the whole sheet dissolves over the first half.
      if (turner) {
        turner.style.opacity =
          flipStyle === 'fade'
            ? String(dir > 0 ? 1 - smooth(0, 0.5, t) : smooth(0, 0.5, t))
            : '1';
      }
      // Swap the underlying page at the end (real) or midpoint (fade).
      if (!flipSwappedRef.current && t >= swapAt) {
        flipSwappedRef.current = true;
        setPageIndex(flip.to);
      }
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        if (turner) {
          turner.style.transform = 'rotateY(0deg)';
          turner.style.opacity = '1';
        }
        if (cast) cast.style.opacity = '0';
        setFlip(null);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip]);

  function turn(delta: number) {
    const step = turnStep;
    if (delta > 0) {
      if (pageIndex + step <= maxPageIndex) flipTo(pageIndex + step, 1);
      else if (next) startTurn(() => openChapter(next.id, { type: 'first' }), true);
    } else {
      if (pageIndex - step >= 0) flipTo(pageIndex - step, -1);
      else if (prev) startTurn(() => openChapter(prev.id, { type: 'last' }), true);
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

  /* ---- keyboard ---- */
  function exitReading() {
    // Persist current position before leaving so progress isn't lost.
    if (current) {
      const off = mode === 'paged' ? offsetForPage(pageIndex) : 0;
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
  }, [mode, prev, next, pageIndex, pageCount, chromeOpen, popover, sel, bmOpen, annOpen, tocOpen, current, id]);

  /* ---- hover the top/bottom edge to reveal the reader chrome (paged) ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
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
  }, [mode]);

  /* ---- selection -> toolbar (paged) ---- */
  useEffect(() => {
    const el = contentRef.current;
    if (!el || mode !== 'paged') return;
    const root = el;
    function onMouseUp() {
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
      setSel({ x: rect.left + rect.width / 2, y: rect.top - 8, start: offs.start, end: offs.end, text: selection.toString() });
    }
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const mark = target.closest('mark.hl') as HTMLElement | null;
      if (mark && mark.dataset.annId) {
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
  }, [mode, annotations]);

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
            <button className="btn sm" onClick={() => nav('/')}>
              书架
            </button>
          </div>

          <article className="reader-paper">
            <div className="reader-content" style={{ fontSize }} dangerouslySetInnerHTML={{ __html: safeHtml }} />
          </article>

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

  // The turning sheet overlay. Only the page being turned is drawn — the RIGHT
  // page for next / LEFT page for prev in two-page mode (the single page in
  // single mode). It is a real 3D plane with a FRONT (the page lifting away) and
  // a BACK (the incoming page) so a "real" turn needs no mid-turn blank. Curl
  // sheen + shadow layers sit on top for paper realism; the static page beneath
  // is untouched until the swap point.
  const renderFlipTurner = () => {
    if (!flip) return null;
    const twoPage = pagesPerView === 2;
    const stepPx = sheetWidth + pageGap;
    const colsW = pageCount > 0 ? pageCount * contentWidth + (pageCount - 1) * columnGap : 0;
    let turnLeft: number;
    let pivotLeft: boolean;
    let startA: number;
    let frontPage: number;
    let backPage: number;
    if (twoPage) {
      if (flip.dir > 0) {
        turnLeft = sheetWidth + pageGap;
        pivotLeft = true;
        startA = 0;
        frontPage = flip.from + 1;
        backPage = flip.to;
      } else {
        turnLeft = 0;
        pivotLeft = false;
        startA = 0;
        frontPage = flip.from;
        backPage = flip.to + 1;
      }
    } else {
      if (flip.dir > 0) {
        turnLeft = 0;
        pivotLeft = true;
        startA = 0;
        frontPage = flip.from;
        backPage = flip.to;
      } else {
        turnLeft = 0;
        pivotLeft = true;
        startA = -180;
        frontPage = flip.to;
        backPage = flip.from;
      }
    }
    const faceCols = (page: number) => (
      <div
        className="reader-columns"
        style={{
          left: marginPx,
          top: marginPx,
          width: colsW,
          height: Math.max(0, contentHeight),
          transform: `translate3d(-${page * stepPx}px, 0, 0)`,
          columnWidth: contentWidth,
          columnGap,
        }}
      >
        <div className="reader-content" style={{ fontSize }} />
      </div>
    );
    return (
      <div
        ref={turnerRef}
        className="flip-turner"
        style={{
          left: turnLeft,
          width: sheetWidth,
          height: sheetHeight,
          transformOrigin: pivotLeft ? 'left center' : 'right center',
          transform: `translateZ(1px) rotateY(${startA}deg)`,
        }}
      >
        <div className="flip-face front" ref={flipFrontRef}>
          <div className="flip-clip">{faceCols(frontPage)}</div>
        </div>
        <div className="flip-face back" ref={flipBackRef}>
          <div className="flip-clip">{faceCols(backPage)}</div>
        </div>
        <div className="flip-sheen" ref={flipSheenRef} />
        <div className="flip-curl" ref={flipCurlRef} />
      </div>
    );
  };

  // In two-page mode the far (non-turning) page simply snaps to its new content
  // at the swap point (handled by flipTo's pageIndex swap); only the turning
  // page animates, so there is no second moving layer to manage.

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
        {flip && geometryReady && (
          <div
            className="flip-cast"
            ref={flipCastRef}
            style={{
              left: pagesPerView === 2 ? (flip.dir > 0 ? 0 : sheetWidth + pageGap) : 0,
              width: sheetWidth,
              height: sheetHeight,
            }}
          />
        )}
        {flip && geometryReady && (
          <div className="reader-flip" style={{ width: viewWidth, height: sheetHeight }}>
            {renderFlipTurner()}
          </div>
        )}
      </div>

      {(chromeOpen || chromeHover) && (
        <>
          <div className="reader-chrome top">
            <div className="chrome-left">
              <button className="btn sm" onClick={() => nav('/')}>
                ← 书架
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
            <button className="btn sm" onClick={() => setFlipSettingsOpen((v) => !v)} title="翻页动画设置">
              翻页
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
          {flipSettingsOpen && (
            <div className={`flip-settings${flipEnabled ? '' : ' off'}`} onClick={(e) => e.stopPropagation()}>
              <div className="fs-head">
                翻页动画
                <button className="btn sm" onClick={() => setFlipSettingsOpen(false)}>
                  ✕
                </button>
              </div>
              <div className="fs-row">
                <label>启用</label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={flipEnabled}
                    onChange={(e) => setFlipEnabled(e.target.checked)}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="fs-row">
                <label>风格</label>
                <div className="seg">
                  <button className={flipStyle === 'real' ? 'on' : ''} onClick={() => setFlipStyle('real')}>
                    真实翻页
                  </button>
                  <button className={flipStyle === 'fade' ? 'on' : ''} onClick={() => setFlipStyle('fade')}>
                    淡化翻页
                  </button>
                </div>
              </div>
              <div className="fs-row">
                <label>时长</label>
                <input
                  type="range"
                  min={260}
                  max={720}
                  step={20}
                  value={flipDuration}
                  onChange={(e) => setFlipDuration(Number(e.target.value))}
                />
                <span className="fs-val">{flipDuration} ms</span>
              </div>
              <div className="fs-row">
                <label>卷曲</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={flipCurl}
                  onChange={(e) => setFlipCurl(Number(e.target.value))}
                />
                <span className="fs-val">{flipCurl}</span>
              </div>
            </div>
          )}
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

      {/* selection toolbar */}
      {sel && (
        <div className="sel-toolbar" style={{ left: sel.x, top: sel.y }}>
          {COLORS.map((c) => (
            <button key={c} className={`swatch sw-${c}`} title={c} onClick={() => createAnnotation(c)} />
          ))}
        </div>
      )}

      {/* annotation popover */}
      {popover && (
        <div className="ann-popover" style={{ left: popover.x, top: popover.y }}>
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
    </div>
  );
}
