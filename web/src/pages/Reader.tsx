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
  MODE_KEY,
  FONT_FAMILY_KEY,
  FONT_OVERRIDE_KEY,
  APP_THEMES,
  appTheme,
  applyAppTheme,
  fontOverrideEnabled,
  type AppTheme,
  type ReadMode,
} from '../readingPrefs';
import { isTouchPrimary } from '../device';
import { closeForNavigation, navigationDepth, useBackClose } from '../backNav';
import FontPicker, { CUSTOM_FONT_FAMILY } from '../components/FontPicker';
import AIPanel from '../components/AIPanel';

const FONT_KEY = 'epubmaker.fontSize';
const TOC_DOCK_KEY = 'epubmaker.tocDocked';

// Width of the docked TOC sidebar (kept in sync with --toc-dock-w in styles.css
// and the .toc sidebar width in scroll mode for visual consistency).
const TOC_DOCK_W = 268;

// Height of the top/bottom band that reveals (or, on touch, toggles) the reader
// chrome. Same band for hover and tap so the affordance is in one place.
const CHROME_EDGE = 64;

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
type PageIntent = { type: 'first' | 'last' | 'restore'; offset?: number } | null;

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
    return () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
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

  // paged reading state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pagesPerView, setPagesPerView] = useState(1);
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
        }
        // A preview visit (生词本 / 划线 / 书签) carries its own anchor, which
        // outranks the saved progress: the whole point is landing on THAT spot.
        // It raises no menus — the anchored highlight alone marks the spot.
        const entry = entryRef.current;
        if (entry && !locationUsedRef.current) {
          restoreOffsetRef.current = entry.offset;
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
  // Theme persists through applyAppTheme at pick time; nothing to save here.
  useEffect(() => localStorage.setItem(TOC_DOCK_KEY, tocDocked ? '1' : '0'), [tocDocked]);
  useEffect(() => localStorage.setItem(FONT_FAMILY_KEY, readFont), [readFont]);
  useEffect(
    () => localStorage.setItem(FONT_OVERRIDE_KEY, fontOverride ? '1' : '0'),
    [fontOverride],
  );

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

    // A jump that wants its target selected (notebook word, annotation line)
    // raises the selection UI once the landed page has painted.
    if (pendingRevealRef.current) {
      const pr = pendingRevealRef.current;
      pendingRevealRef.current = null;
      requestAnimationFrame(() => requestAnimationFrame(() => revealOffsets(pr.start, pr.end)));
    }

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
  // The chapter list is complete by construction, so it wins both times; the
  // outline is drawn only when it is hierarchical *and* reaches every chapter.
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
    return { reached: ids.size, nested };
  }, [toc, byHref]);
  const useTocTree = toc.length > 0 && tocShape.nested && tocShape.reached >= chapters.length;
  const currentChapter = current ? (chapters.find((c) => c.id === current) ?? null) : null;
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
    // Preview visits do not turn pages: the position must stay on the anchor,
    // and every save guard aside, drifting would break the "temporary look"
    // model. Use the banner's two exits to leave the mode.
    if (previewRef.current) return;
    // The card points at a word on the page being left behind.
    cancelWordLookup();
    setLookupCard(null);
    if (sel) clearSelectionUI();
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
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        horizontal = true;
        if (e.cancelable) e.preventDefault();
      }
    };

    const onEnd = (e: TouchEvent) => {
      cancelLongPress();
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!horizontal) {
        // A tap: the native click was suppressed at touchstart, so route it
        // ourselves. A hold that produced a selection is not a tap.
        if (!lpFired && Date.now() - startT < TAP_MS) routeTapRef.current(t.clientX, t.clientY);
        return;
      }
      if (Math.abs(dx) < MIN_TRAVEL) return;
      if (Math.abs(dx) < Math.abs(dy) * MIN_RATIO) return;
      // The gesture was ours end to end; no stray click can follow.
      turnedAtRef.current = Date.now();
      // Dismiss whatever floats over the page only once the gesture is over.
      // Unmounting the element under the finger mid-drag makes the browser
      // cancel the touch sequence, and the page turn never happens — which is
      // how "swipe while the word card is open" stayed broken even after the
      // listener moved to the reader root.
      setSel(null);
      setPopover(null);
      setChromeOpen(false);
      turn(dx < 0 ? 1 : -1);
    };

    const onCancel = () => {
      cancelLongPress();
      active = false;
      horizontal = false;
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
  async function createAnnotation(color: string) {
    if (!sel || !current) return;
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
      clearSelectionUI();
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
      // Both modes anchor to a source character offset; scrolling has no page
      // map, so the anchor is whatever text sits at the top of the pane.
      const off = mode === 'paged' ? offsetForPage(pageIndex) : offsetAtViewportTop();
      const b = await api.addBookmark(id, current, off, '');
      setBookmarks((prev) => [...prev, b]);
      toast('已添加书签', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  // The reading surface's text style. The custom family falls back to a serif
  // so Chinese/latin text stays legible during the (brief) font load.
  const contentStyle: CSSProperties = { fontSize };
  if (readFont !== 'default') contentStyle.fontFamily = `'${CUSTOM_FONT_FAMILY}', Georgia, serif`;

  async function removeBookmark(bid: string) {
    try {
      await api.deleteBookmark(bid);
      setBookmarks((prev) => prev.filter((x) => x.id !== bid));
      toast('已删除书签', 'success');
    } catch (e) {
      toastError(e);
    }
  }

  // The bookmark standing for "this page" (phone: the star in the top bar).
  // Paged mode matches exactly via the offset->page map; scrolling compares
  // against the offset at the top of the pane with slack, because the pane
  // moves in pixel steps the map does not model.
  function currentPageBookmark(): Bookmark | null {
    if (!current) return null;
    if (mode === 'paged') {
      return (
        bookmarks.find(
          (b) => b.chapterId === current && pageIndexForOffset(b.anchor) === pageIndex,
        ) ?? null
      );
    }
    const top = offsetAtViewportTop();
    return bookmarks.find((b) => b.chapterId === current && Math.abs(b.anchor - top) < 500) ?? null;
  }

  async function togglePageBookmark() {
    const existing = currentPageBookmark();
    if (existing) await removeBookmark(existing.id);
    else await addBookmarkNow();
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
     chapter slider between 上一章/下一章, a percentage caption, and a five-slot
     action row (目录 · 书签 · 划线 · 整理 · 设置). The desktop keeps its own
     bars — the two never render together, gated on touchPrimary. */
  // Only measured while the mobile chrome is actually up: in scroll mode the
  // helper walks text nodes, and doing that on every desktop render is waste.
  const pageBookmark = touchPrimary && chromeOpen ? currentPageBookmark() : null;

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
  const iconEdit = (
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
      <path d="M11 4H4v16h16v-7" />
      <path d="M17.5 3.5a2.12 2.12 0 013 3L13 14l-4 1 1-4z" />
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
      <button className="m-tab" onClick={() => nav(`/books/${id}/edit`)}>
        {iconEdit}
        <span>整理</span>
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
      <div className="m-slider-pct">
        {Math.round(progressPct)}% · 第 {pageIndex + 1}/{pageCount} 页
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
    </div>
  );

  const overlayLayer = (
    <>
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
              colours while scrolling would promise something invisible. */}
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
              <p className="ai-sentence">{highlightWord(aiPanel.sentence, aiPanel.word)}</p>
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
        />
      )}

      {aiPanel?.kind === 'parse' && (
        <AIPanel<ParseResult>
          title="✦ AI 拆句"
          run={() => api.parseSentence(aiPanel.sentence)}
          render={(r) => (
            <>
              {r.cached && <span className="ai-cache-badge">缓存结果</span>}
              <p className="ai-sentence">{aiPanel.sentence}</p>
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
        />
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
              entries={toc}
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
                entries={toc}
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
          className={`reader-spread${fxOut ? ' fx-out' : ''}`}
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
              <div className="reader-content" ref={contentRef} style={contentStyle} />
            </div>
          </div>
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
                  entries={toc}
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
