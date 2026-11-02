import {
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
import { toast, toastError } from '../toast';
import { EDGE_GAP } from '../overlay';
import { wordAt, isCJK, stripInvisible } from '../wordHit';
import {
  anchorOffset,
  blockOf,
  charOffset,
  getSelectionOffsets,
  CHAPTER_PURIFY,
  lineBreakBetween,
  sentenceAt,
  textNodeAt,
} from '../sentence';
import { speakWord } from '../speech';
import { publishNowPlaying, type NowPlaying } from '../readAloud';
import ListenBar from '../components/ListenBar';
import {
  MODE_KEY,
  FONT_FAMILY_KEY,
  FONT_OVERRIDE_KEY,
  TURN_SENSITIVITY_KEY,
  TURN_SENSITIVITY_LEVELS,
  TAP_TURN_KEY,
  TAP_TURN_PCT,
  APP_THEMES,
  appTheme,
  applyAppTheme,
  fontOverrideEnabled,
  tapTurnEnabled,
  turnSensitivity,
  turnThresholds,
  type AppTheme,
  type ReadMode,
  type TurnSensitivity,
} from '../readingPrefs';
import { isTouchPrimary, prefersReducedMotion, readViewport } from '../device';
import { usePageTurns, type TurnDrag } from '../usePageTurns';
import { useListenSession, INACTIVE_NOW_PLAYING } from '../useListenSession';
import ListenSettings from '../components/ListenSettings';
import { useAnchoredOverlay, overlayStyle } from '../useAnchoredOverlay';
import {
  applyHighlights,
  fragmentAt,
  selectionEndRects,
  snapRect,
  wordRangeAt,
} from '../textOffset';
import {
  anchorElement,
  anchorIdOf,
  countTocEntries,
  docKey,
  findTocPath,
  initialTocFold,
  hrefsInDoc,
  readTocView,
  TOC_VIEW_KEY,
  type TocView,
} from '../tocNav';
import { TocList, TocLocate, TocSeg } from '../components/Toc';
import { closeForNavigation, navigationDepth, useBackClose } from '../backNav';
import FontPicker, { CUSTOM_FONT_FAMILY } from '../components/FontPicker';
import AIPanel from '../components/AIPanel';
import AISentence from '../components/AISentence';
import { TurnPeek } from '../components/TurnPeek';
import { lastTextPage } from '../columns';

const FONT_KEY = 'epubmaker.fontSize';
const TOC_DOCK_KEY = 'epubmaker.tocDocked';

// Where scroll mode parks its position, per book. Since progress moved to the
// backend (`PageIntent` 'restore' re-derives the page from a source offset) no
// one reads this key back — the write in the chapter effect is now the only
// half of the round trip. Left alone here rather than deleted: this change only
// moves code.
const posKey = (id: string) => `epubmaker.pos.${id}`;

// Width of the docked TOC sidebar (kept in sync with --toc-dock-w in styles.css
// and the .toc sidebar width in scroll mode for visual consistency).
const TOC_DOCK_W = 268;

// Height of the top/bottom band that reveals (or, on touch, toggles) the reader
// chrome. Same band for hover and tap so the affordance is in one place.
const CHROME_EDGE = 64;

/** Below this the scroll-mode aside is hidden (it becomes the drawer), so no
 *  outline is on screen to highlight. Matches the CSS breakpoint. */
const NARROW_QUERY = '(max-width: 980px)';

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

const COLORS = ['yellow', 'green', 'red'] as const;

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

  // 点两侧翻页. Live state so the Aa sheet answers a tap immediately: the tap
  // router reads this value on every tap, so no listener has to be re-registered
  // (which is why `turnSens` needs a ref and this does not).
  const [tapTurn, setTapTurn] = useState<boolean>(tapTurnEnabled);

  // paged reading state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // How many columns the strip is wide. Not the same as pageCount: the last
  // column can be empty (a block ending a few pixels past a column edge), and
  // the strip still has to be wide enough to hold every column that has text in
  // it. Turnable pages are pageCount; the box is stripCols.
  const [stripCols, setStripCols] = useState(1);
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

  // A page turn the FINGER owns (touch), see `usePageTurns.ts`. While the finger is
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
  // The tag hanging out of the page's top edge, and the gesture that pulls it
  // out (see `usePageTurns.ts`). Both are written straight to the DOM for the
  // same reason the page turn is: this runs on every touchmove.
  const tagWrapRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  // The gesture lives in an effect registered once per page, so it cannot read
  // the bookmark callbacks of the render it was created in; it calls through
  // this instead. Assigned at the bottom of the bookmark section.
  const bookmarkToggleRef = useRef<() => void>(() => {});
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
  // The chapter handoff (see measureAndLayout) lives above the page-turn hook's
  // call site and cannot call into it, so the one operation it needs — put the
  // drag down together with the peek — is borrowed through this.
  const dropDragRef = useRef<() => void>(() => {});

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
  // When a touch tap was last answered. `routeTap()` is the only router for one
  // (ADR-43); this is what keeps a WebView that still synthesises a click after
  // the prevented touchstart from answering the same tap twice.
  const tapAtRef = useRef(0);
  const pageIntentRef = useRef<PageIntent>(null);
  // Layout-independent restore target: a source character offset to land on.
  // Kept in a ref (not a one-shot intent) so it survives across measure passes
  // — e.g. when the first measurement happens before the stage is laid out.
  const restoreOffsetRef = useRef<number | null>(null);
  // The chapter a pending restore offset belongs to. Restore offsets and
  // chapter intents may only be consumed by a measure pass whose DOM actually
  // holds that chapter — see htmlChapterRef below.
  const restoreCidRef = useRef<string | null>(null);
  // A TOC entry that points at a section *inside* a document: the anchor name
  // (the nav href's #fragment) plus the chapter that carries it. Resolved to a
  // text offset by the first measure pass / scroll restore that holds that
  // chapter, because the element only exists once the HTML is in the DOM.
  const anchorJumpRef = useRef<{ cid: string; anchor: string } | null>(null);
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
  // A resize was refused because a field had focus and the view had shrunk —
  // i.e. it looked like a soft keyboard. The refusal is a deferral, not a
  // verdict: the moment that field is done, the page still has to fit (see the
  // focusout listener in the measure effect).
  const keyboardSkipRef = useRef(false);

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
        // The fold is seeded here, not in an effect: an effect would paint the
        // outline once with every group open and fold it a frame later, which
        // on 三体 is a 200-row jump under the reader's eyes.
        setTocCollapsed(initialTocFold(tocEntries ?? [], cs.find((c) => c.id === target)?.href));
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
  useEffect(() => localStorage.setItem(TAP_TURN_KEY, tapTurn ? '1' : '0'), [tapTurn]);

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

  // Scroll-mode counterpart of the anchor jump: the TOC asked for a section in
  // the middle of this document, so after the html is committed, move the
  // container to the anchor instead of leaving the reader at the top.
  useEffect(() => {
    if (mode !== 'scroll' || !anchorJumpRef.current) return;
    if (!contentRef.current) return;
    const off = takeAnchorOffset(current);
    if (off === null) return;
    const after = scrollTextTo(off);
    if (!after) return;
    if (!preview && current) api.saveProgress(id, current, off, 1).catch(() => {});
    setFlash({
      left: after.left - 2,
      top: after.top - 3,
      width: Math.max(after.width, 6),
      height: after.height + 6,
    });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeHtml, mode]);

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
    // The flag belongs to THIS registration, not to the reader. It says "a
    // measurement was skipped and is owed", and the `focusout` that pays it
    // back is registered below, in the same breath — so a mark left behind by
    // an effect that has already been torn down is a debt no one can collect
    // any more. It is paid by accident often enough to look harmless (the next
    // `update` clears it as soon as the field is gone), but "often enough" is
    // not a rule: focus a field, switch to scroll mode, switch back, and the
    // paged listener came back owing a measurement it had already been served.
    keyboardSkipRef.current = false;
    const update = () => {
      const next = readViewport();
      // A soft keyboard shrinking the view must not re-paginate the chapter: the
      // page count would change while the reader is typing an annotation and
      // change back when the keyboard closes, so the text would jump twice per
      // comment. The overlays follow the keyboard themselves; the page does not.
      //
      // Two things make this a deferral rather than a permanent verdict. A
      // change in WIDTH is never a keyboard (rotation, a split screen, the
      // window being dragged narrower), so it is always obeyed. And a skip is
      // remembered: `focusout` below re-runs the measurement once the field is
      // done. Without both, a device that leaves the composer focused after the
      // keyboard goes away — Android does — froze the geometry for the rest of
      // the session: the sheet stayed 844 tall inside a 600px window.
      const sameWidth = next.w === winSizeRef.current.w;
      if (next.keyboard && sameWidth && next.h < winSizeRef.current.h) {
        keyboardSkipRef.current = true;
        return;
      }
      keyboardSkipRef.current = false;
      // Snapshot the window size synchronously so measureAndLayout reads a
      // fresh value even if the inner element's clientWidth lags the resize.
      winSizeRef.current = { w: next.w, h: next.h };
      setStageWidth(winSizeRef.current.w);
      setStageHeight(winSizeRef.current.h);
      // Re-measure on every size change so the page count (1 vs 2) and sheet
      // geometry adapt to the window.
      scheduleMeasure();
    };
    // The other half of the keyboard guard: a skip that was a keyboard is paid
    // back here, and one that was not is corrected as soon as it is clear.
    const onFocusOut = () => {
      if (!keyboardSkipRef.current) return;
      keyboardSkipRef.current = false;
      update();
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
    // Capture phase: the field that had focus may be inside a sheet that is
    // about to unmount, and focusout does not bubble from a removed node.
    document.addEventListener('focusout', onFocusOut, true);
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      vv?.removeEventListener('resize', update);
      document.removeEventListener('focusout', onFocusOut, true);
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

  // The offset just past the last page on screen. The outline uses it to decide
  // which section the reader is *in*: a page that shows where a section starts
  // counts as being in that section, so jumping to 第7章 does not keep saying
  // 第6章 while the 第7章 heading sits halfway down the same page.
  function offsetAfterLastPage(): number {
    return pageStartOffset(pageIndex + pagesPerView) ?? Number.MAX_SAFE_INTEGER;
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

    // A TOC entry pointing at a section inside a document (nav anchors carry
    // #filepos…): land on the page that holds the anchor, not on page one.
    // Resolved here because this is the first pass with both the chapter's DOM
    // and the offset map.
    const anchorOff = takeAnchorOffset(htmlChapterRef.current);

    if (anchorOff !== null && offsetMapRef.current.length > 0) {
      nextPage = Math.min(pageIndexForOffset(anchorOff), maxIdx);
      landed = true;
    } else if (
      restoreOffsetRef.current !== null &&
      restoreHere &&
      offsetMapRef.current.length > 0
    ) {
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
        dropDragRef.current();
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
    noteOwnScroll();
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
    return offsetAtViewportY(false);
  }

  /** Same measurement at either edge of the reading pane: `fromBottom` answers
   *  "which text is at the end of what I can see", which is how a scroll-mode
   *  page decides the section it is in (the paged rule, in one dimension). */
  function offsetAtViewportY(fromBottom: boolean): number {
    const root = contentRef.current;
    const scroller = mainRef.current;
    if (!root || !scroller) return 0;
    const box = scroller.getBoundingClientRect();
    const x = box.left + Math.min(120, scroller.clientWidth / 2);
    const y = fromBottom ? box.bottom - 6 : box.top + 6;
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
    // that reaches past the edge. Coarse (whole node), still better than 0.
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
    const flush = () => {
      api.saveProgress(id, current, offsetForPage(pageIndex), pageCount).catch(() => {});
    };
    const t = setTimeout(flush, 600);
    // A debounce that has not elapsed yet is a page that never got saved: a
    // phone freezes the WebView the moment the app goes to the background, and
    // the freeze beats the 600ms. These two events are the last chance to
    // write, and both fire while the DOM is still readable, so the offset is
    // still the one on screen. `visibilitychange` is the phone's case (Home,
    // another app), `pagehide` the tab being closed or navigated away.
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [mode, current, pageIndex, pageCount, id, preview]);

  /* ---- progress persistence (scrolling mode) ---- */
  useEffect(() => {
    if (mode !== 'scroll' || !current || preview) return;
    const scroller = mainRef.current;
    if (!scroller) return;
    let timer = 0;
    const saveNow = () => api.saveProgress(id, current, offsetAtViewportTop(), 1).catch(() => {});
    const onScroll = () => {
      // In scroll mode, scrolling IS the page turn: the reader has moved the
      // text themselves, so the voice must stop dragging it back to the
      // sentence it is reading. Our own reveal-scroll is not that.
      if (!recentScrollWasOurs()) pauseFollow();
      window.clearTimeout(timer);
      timer = window.setTimeout(saveNow, 800);
    };
    // Same last chance as paged mode: an 800ms debounce loses to a freeze.
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', saveNow);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', saveNow);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, current, id, preview, safeHtml]);

  const idx = chapters.findIndex((c) => c.id === current);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  // The neighbours as the LONG-LIVED callbacks see them. The gesture listeners
  // are registered once per chapter (see `usePageTurns.ts`): a callback captured
  // there would otherwise still be holding the neighbours of the chapter the
  // reader opened with, and the first turn past an edge would aim at the wrong
  // chapter — or at none at all.
  const nextRef = useRef(next);
  nextRef.current = next;
  const prevRef = useRef(prev);
  prevRef.current = prev;
  const progressPct = chapters.length
    ? ((idx + (pageCount ? pageIndex / pageCount : 0)) / chapters.length) * 100
    : 0;
  const laidOut = sheetWidth > 0 && contentWidth > 0;

  /* ---- 听书: the session ---- */
  // Everything the voice needs from this page arrives here, once: the chapter it
  // is reading, the geometry that turns a sentence into a page, and the
  // neighbour to read into at a boundary. The hook owns the queue and the three
  // engines; this page owns the book. The two names that are *not* passed in are
  // the two it calls back through — `openChapter` and `setPageIndex` — because
  // moving a page is this page's job, not the voice's (ADR-45's line, kept).
  const listenSession = useListenSession({
    html: safeHtml,
    contentRef,
    stageRef,
    mainRef,
    mode,
    pageIndex,
    setPageIndex,
    pageIndexForOffset,
    offsetForPage,
    offsetAtViewportTop,
    openChapter,
    next,
    prev,
    chapterTitle: chapters.find((c) => c.id === current)?.title || '',
    fontSize,
    fontEpoch,
    theme,
  });
  const {
    listen,
    listenMarks,
    listenSheet,
    setListenSheet,
    following,
    edgeVoices,
    listenRate,
    listenEngine,
    listenVoice,
    spansRef,
    nowPlayingRef,
    startListen,
    stopListen,
    toggleListen,
    jumpListen,
    pauseFollow,
    resumeFollow,
    listenVoiceLabel,
    changeListenRate,
    setListenRateTo,
    switchListenEngine,
    switchListenVoice,
    recentScrollWasOurs,
    noteOwnScroll,
  } = listenSession;

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
    if (prefersReducedMotion()) return;
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
  // Which of the two lists the panel is showing. The choice is a preference
  // (it survives a restart), not a property of the book, so it is stored once
  // and shared by every book — the same drawer, the same two answers.
  //
  // When nothing has been chosen yet the nav wins, because it is the book's own
  // outline. The exception is a nav that names fewer sections than the spine
  // has documents: converted EPUBs are the usual offenders (calibre split a
  // book into 28 files and wrote three labels), and three rows over 28 chapters
  // is not an outline anyone can use. That is a *default*, not a merge — the
  // nav is still one tap away and stays exactly as written.
  const [tocPref, setTocPref] = useState<TocView | null>(readTocView);
  const setTocView = (v: TocView) => {
    setTocPref(v);
    try {
      localStorage.setItem(TOC_VIEW_KEY, v);
    } catch {
      // Private mode: the choice still applies to this session.
    }
  };
  const navCount = useMemo(() => countTocEntries(toc), [toc]);
  const hasNav = toc.length > 0;
  const navView = hasNav && (tocPref ?? (navCount < chapters.length ? 'file' : 'nav')) === 'nav';
  const tocView: TocView = navView ? 'nav' : 'file';
  const tocCount = navView ? navCount : chapters.length;
  const tocUnit = navView ? '节' : '章';

  const currentChapter = current ? (chapters.find((c) => c.id === current) ?? null) : null;
  const activeDoc = currentChapter?.href ?? null;

  /* The media notification's contents. Published only when the widget would
     actually look different: the session object is rebuilt on every sentence,
     and one notification per sentence would be several hundred pointless
     updates in a single chapter. */
  useEffect(() => {
    const np: NowPlaying = listen
      ? {
          active: true,
          playing: listen.playing,
          // The chapter is what the reader is following; the book goes under it.
          title: currentChapter?.title || book?.title || '',
          artist: book?.title || '',
          canPrev: listen.index > 0 || !!prev,
          canNext: listen.index < spansRef.current.length - 1 || !!next,
        }
      : INACTIVE_NOW_PLAYING;
    const json = JSON.stringify(np);
    if (json === nowPlayingRef.current) return;
    nowPlayingRef.current = json;
    publishNowPlaying(np);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listen, currentChapter, book, prev, next]);

  // Which section the reader is inside. A nav can name several sections inside
  // one document — 邓小平时代's 第6章 and 第7章 both live in split_004 — so
  // matching rows by document lit both of them, which is what made a chapter
  // look duplicated. The section is the last entry of this document whose
  // anchor has already passed the bottom edge of what is on screen, measured as
  // a character offset so it means the same thing in both reading modes. Until
  // it has been measured the first entry of the document stands in, so exactly
  // one row is ever highlighted.
  const [activeSection, setActiveSection] = useState<string | null>(null);
  // A list has to be on screen for its highlight to matter: the paged reader's
  // drawer and dock, or the scroll reader's aside — which CSS replaces with the
  // drawer below 980px.
  const [wideLayout, setWideLayout] = useState(() => !window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setWideLayout(!mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const tocVisible = tocOpen || tocDocked || (mode === 'scroll' && wideLayout);
  useEffect(() => {
    if (!navView || !tocVisible || !activeDoc) {
      setActiveSection(null);
      return;
    }
    const hrefs = hrefsInDoc(toc, activeDoc);
    if (hrefs.length <= 1) {
      setActiveSection(hrefs[0] ?? null);
      return;
    }
    const root = contentRef.current;
    if (!root) {
      setActiveSection(hrefs[0]);
      return;
    }
    const pick = () => {
      const pos = mode === 'paged' ? offsetAfterLastPage() : offsetAtViewportY(true);
      let best = hrefs[0];
      for (const href of hrefs) {
        const el = anchorElement(root, anchorIdOf(href));
        if (el && anchorOffset(root, el) <= pos) best = href;
      }
      setActiveSection(best);
    };
    if (mode !== 'scroll') {
      pick();
      return;
    }
    // Scroll mode has no page event to hang this on: the section changes when
    // the reader scrolls past an anchor, and only then.
    const scroller = mainRef.current;
    if (!scroller) {
      pick();
      return;
    }
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(pick);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    pick();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
    // `html` and `pageCount` stand in for "the chapter was laid out": the first
    // render after a chapter change has no offset map yet, and measuring twice
    // is cheaper than a highlight that never catches up.
  }, [navView, tocVisible, activeDoc, toc, mode, pageIndex, pageCount, html]);

  const activeSet = useMemo(() => {
    if (!navView || !activeDoc) return new Set<string>();
    const hrefs = hrefsInDoc(toc, activeDoc);
    const one = activeSection && hrefs.includes(activeSection) ? activeSection : hrefs[0];
    return new Set(one ? [one] : []);
  }, [navView, toc, activeDoc, activeSection]);

  // Whatever the reader folds by hand, the chapter he is in stays reachable
  // without unfolding anything: its ancestors open when it changes. That is
  // also the one moment a hand-folded group should open again — he just asked
  // to go in there. The first fold is seeded where the outline lands (see the
  // load effect); 定位 (locateCurrent) stays for folding the path by hand.
  useEffect(() => {
    if (!activeDoc) return;
    const path = findTocPath(toc, docKey(activeDoc));
    if (!path.length) return;
    setTocCollapsed((prev) => {
      if (!path.some((k) => prev.has(k))) return prev;
      const n = new Set(prev);
      for (const k of path) n.delete(k);
      return n;
    });
  }, [toc, activeDoc]);

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
  /** Consumes the pending TOC anchor if it belongs to this chapter and returns
   *  the text offset it marks. The anchor only becomes a position once the
   *  chapter's HTML is in the DOM, which is why this runs inside the measure /
   *  scroll-restore pass rather than at click time. */
  function takeAnchorOffset(cid: string | null): number | null {
    const jump = anchorJumpRef.current;
    if (!jump || !cid || jump.cid !== cid) return null;
    anchorJumpRef.current = null;
    const root = contentRef.current;
    if (!root) return null;
    const el = anchorElement(root, jump.anchor);
    return el ? anchorOffset(root, el) : null;
  }

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

  /** A click in the outline: open the chapter the entry belongs to, then move
   *  to the section it names. Most nav entries point inside their document
   *  (`…html#filepos330338`) — the chapter is only the container. */
  function pickToc(cid: string, href?: string) {
    if (previewRef.current) return;
    anchorJumpRef.current = null;
    const anchor = href ? anchorIdOf(href) : '';
    openChapter(cid, { type: 'first' });
    if (anchor) anchorJumpRef.current = { cid, anchor };
  }

  // The width of one spread: what the band travels across during a turn, and
  // what the clip is sized to. Derived here rather than in the render section
  // below, because the page-turn hook is registered before that section runs.
  const viewWidth = pagesPerView * sheetWidth + (pagesPerView - 1) * pageGap;
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

  // Routes one tap (touch, after the reader claimed the gesture) to its
  // meaning. Same division of labour as onStageClick's touch branch, but it
  // works on raw coordinates: the native click event never fires for a touch
  // this reader has prevented.
  function routeTap(x: number, y: number) {
    if (Date.now() - turnedAtRef.current < 300) return;
    // One tap, one answer: this is the only place a touch tap is routed, and
    // the timestamp is how a synthesised click is kept out of it.
    tapAtRef.current = Date.now();
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
    // 点两侧翻页, when the switch is on. Deliberately ABOVE the word lookup:
    // the strip is a fifth of a page wide, so text lives inside it, and a lookup
    // that won this race would leave the switch answering only on the blank
    // outer margin — the 22px ADR-43 measured, which nobody hits on purpose.
    // The cost is the one ADR-43 named, now a choice the reader makes by turning
    // this on: a tap on a word inside the strip turns the page. A press still
    // selects it, and selection is how this reader reads a word anyway.
    //
    // Paged mode only. In scroll mode there is no next page to turn towards and
    // `turn()` would carry the reader into the next chapter, which is not what
    // a tap on a margin means.
    if (tapTurn && mode === 'paged' && !preview) {
      const dir = tapTurnZoneAt(x);
      if (dir !== 0) {
        turn(dir);
        return;
      }
    }
    if (scheduleWordLookup(x, y)) return;
    // The one rule the two modes do not share, and deliberately so. Paged mode
    // has no scrolling, so a tap is always aimed and any tap may open the
    // chrome. In scroll mode a tap is often the tail of a scroll, and a menu
    // appearing over the paragraph you were reading reads as a bug — so only
    // the middle third answers. Everything above (card, mark, word) is the same
    // in both, which is why there is one router and not one per mode.
    if (mode === 'scroll') {
      const ratio = x / Math.max(1, window.innerWidth);
      if (!(ratio > 1 / 3 && ratio < 2 / 3)) return;
    }
    // Taps never turn pages on touch — a page turn is a horizontal swipe.
    // Everything that is not a word lookup toggles the chrome, which is also
    // how the edge menus come and go.
    setChromeOpen((o) => !o);
  }
  const routeTapRef = useRef(routeTap);
  routeTapRef.current = routeTap;

  /* ---- the turn the finger owns ---- */
  // Everything below the tap router is a hook: the gesture, the drag it owns,
  // the ribbon it pulls out of the page and the release that decides between
  // going on and going back. What stays here is what a gesture MEANS in this
  // book — which tap is a lookup, which chapter comes next, what a selection
  // is to the notebook. The two change for different reasons.
  const pageTurns = usePageTurns({
    mode,
    hostRef: readerRef,
    peekRef,
    dragLayerRef,
    veilRef,
    tagWrapRef,
    tagRef,
    chapterKey: current,
    pageIndex,
    setPageIndex,
    turnStep,
    maxPageIndex,
    viewWidth,
    turnDrag,
    setTurnDrag,
    turnGeomRef,
    peekHandoffRef,
    preview: !!preview,
    peekLive,
    next,
    prev,
    nextRef,
    prevRef,
    turnSensRef,
    turnedAtRef,
    bookmarkToggleRef,
    dropDragRef,
    onTap: (x, y) => routeTapRef.current(x, y),
    cancelLookup: cancelWordLookup,
    dropLookup: () => {
      cancelWordLookup();
      setLookupCard(null);
    },
    onTurnCommit: pauseFollow,
    onClearSelection: () => {
      if (sel) clearSelectionUI();
    },
    onDismiss: () => {
      setSel(null);
      setPopover(null);
      setChromeOpen(false);
    },
    onSlide: slideTurn,
    onDissolve: startTurn,
    onOpenChapter: openChapter,
    onSelectWord: selectWord,
    onSelectionStart: releaseSelection,
    hitWord: wordHitAt,
  });
  const { turn } = pageTurns;

  /* ---- the two ends of a selection ---- */
  // A new press on the page ends the previous word selection. Dragging a handle
  // or tapping the toolbar is exempt: the gesture's own ignore list keeps those
  // from ever reaching here.
  function releaseSelection() {
    selLockRef.current = false;
    contentRef.current?.classList.remove('allow-sel');
    const s = window.getSelection();
    if (s && !s.isCollapsed) s.removeAllRanges();
  }

  // A hold that landed on a word. The selection is the reader's to own, not the
  // gesture's: it outlives the touch that made it, and the handles under it
  // belong to the selection toolbar.
  //
  // Blink refuses selections inside user-select:none subtrees, so the flag goes
  // on for the selection's whole lifetime — until the next touchstart, above.
  function selectWord(range: Range) {
    setLookupCard(null);
    contentRef.current?.classList.add('allow-sel');
    selLockRef.current = true;
    selRangeRef.current = range;
    const s = window.getSelection();
    if (s) {
      s.removeAllRanges();
      s.addRange(range);
    }
    applySelRange(range);
  }

  /* keep the current view inside the book when switching 1<->2 page mode */
  useEffect(() => {
    if (mode !== 'paged') return;
    if (pageIndex > maxPageIndex) setPageIndex(maxPageIndex);
  }, [mode, pageCount, pagesPerView]);

  // Which edge zone a viewport x sits in — -1 the covered pages to the left of
  // the book, 0 the page itself, 1 the covered pages to the right — for a strip
  // `band` wide measured from the book's own edge.
  //
  // The zones are measured from the BOOK, not from the window: on a wide screen
  // all the empty space flanking the book still turns pages, and on any screen
  // the book's own outer margin does too — that margin is the "stack of paper"
  // the reader aims at. A proportional share of the window used to turn pages
  // from inside the text column on small windows, which is where words are.
  function edgeZoneAt(clientX: number, band: number): -1 | 0 | 1 {
    const spread = spreadRef.current;
    if (!spread) return 0;
    const r = spread.getBoundingClientRect();
    if (r.width <= 0) return 0;
    if (clientX < r.left + band) return -1;
    if (clientX > r.right - band) return 1;
    return 0;
  }

  // The paper's own margin: desktop clicks and the drag-to-turn gesture.
  function turnZoneAt(clientX: number): -1 | 0 | 1 {
    // On touch the margin is only ~22px, so the band must stay well inside it —
    // otherwise tapping the first character of a line turns the page instead of
    // opening the dictionary card, which is the more common intent by far.
    return edgeZoneAt(clientX, touchPrimary ? 14 : Math.min(marginPx, 26));
  }

  // The strip 点两侧翻页 answers in: a share of ONE page on each side. Larger
  // than `turnZoneAt`'s margin by design — a switch that has to be aimed at a
  // 14px strip is not a feature, it is a puzzle.
  function tapTurnZoneAt(clientX: number): -1 | 0 | 1 {
    return edgeZoneAt(clientX, (sheetWidth * TAP_TURN_PCT) / 100);
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

    // Touch division of labour (微信读书/番茄 school), one rule: a tap never
    // turns a page. See `routeTap` for the order of meanings; it is the same
    // list, called from `onEnd` for a real gesture. This branch only answers a
    // click the WebView synthesised anyway — after the prevented touchstart the
    // gesture has already been routed, so anything within the dedupe window is
    // the tail of that same tap.
    if (touchPrimary) {
      if (Date.now() - tapAtRef.current < 400) return;
      routeTap(e.clientX, e.clientY);
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
    // The release that dismisses a card is spent on the card: the click the
    // browser synthesises right after it belongs to that dismissal, not to
    // whatever word sits under the finger. Paged mode reaches the same
    // conclusion inside `routeTap`, which still sees the card in its state;
    // this effect is never re-registered when a card opens, so it asks the DOM
    // instead of a variable that would be one card out of date.
    let cardJustDismissed = false;
    function onMouseUp() {
      // Any new interaction in the text dismisses the previous dictionary card.
      cardJustDismissed = !!document.querySelector('.dict-card');
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
      // Touch division of labour, same as paged mode — one router, two modes: a
      // tap on a word looks it up; a tap anywhere else opens or closes the
      // chrome. The one rule the modes do not share lives inside `routeTap`.
      if (touchPrimary) {
        if (cardJustDismissed) {
          cardJustDismissed = false;
          return;
        }
        routeTapRef.current(e.clientX, e.clientY);
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
  // The pull gesture was registered before this function existed (it is created
  // once per page), so it reaches the current one through a ref.
  bookmarkToggleRef.current = togglePageBookmark;

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

  // The tag on the page itself. It is shown whether or not the chrome is open —
  // it is the page's own state, and it is what a downward pull moves — so it is
  // computed unconditionally in paged mode. Scrolling has no page for a tag to
  // hang from (and no pull gesture: the gesture only runs in paged mode).
  const pageTagged = mode === 'paged' && currentPageBookmark() !== null;

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
            // Dragging the slider is a deliberate move through the chapter.
            pauseFollow();
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
            {/* Off is a legitimate choice, not a fallback: ADR-43 shipped "a
                tap never turns the page" and a reader who liked it must be able
                to keep it. Only paged mode answers — see `routeTap`. */}
            <div className="rd-set-row">
              <span className="rd-set-label">
                点两侧翻页
                <small className="rd-set-desc">
                  左右各 {TAP_TURN_PCT}% 点一下翻页 · 仅翻页模式
                </small>
              </span>
              <button
                role="switch"
                aria-checked={tapTurn}
                aria-label="点两侧翻页"
                className={`rd-switch${tapTurn ? ' on' : ''}`}
                onClick={() => setTapTurn((v) => !v)}
              >
                <span className="rd-switch-knob" />
              </button>
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
          following={following}
          voiceLabel={listen.engine === 'online' ? listenVoiceLabel() : undefined}
          onToggle={toggleListen}
          onPrev={() => jumpListen(-1)}
          onNext={() => jumpListen(1)}
          onFollow={resumeFollow}
          onRate={changeListenRate}
          onSettings={() => setListenSheet(true)}
          onClose={stopListen}
          // Clear of the bottom chrome while it is up (the detour bar uses the
          // same two numbers), flush to the edge when it is not.
          style={{ bottom: chromeOpen ? (touchPrimary ? 158 : 58) : 14 }}
        />
      )}

      {listenSheet && (
        <ListenSettings
          engine={listenEngine}
          voice={listenVoice}
          rate={listenRate}
          voices={edgeVoices}
          onEngine={switchListenEngine}
          onVoice={switchListenVoice}
          onRate={setListenRateTo}
          onClose={() => setListenSheet(false)}
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
            {hasNav ? <TocSeg view={tocView} onChange={setTocView} /> : <span>目录</span>}
            <span className="toc-n">
              {tocCount} {tocUnit}
            </span>
            <TocLocate onClick={locateCurrent} />
          </div>
          <TocList
            view={tocView}
            toc={toc}
            chapters={chapters}
            itemClass="toc-item"
            activeSet={activeSet}
            resolve={resolveTocHref}
            onPick={pickToc}
            current={current}
            openChapter={openChapter}
            collapsed={tocCollapsed}
            onToggle={toggleToc}
          />
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
            {hasNav ? <TocSeg view={tocView} onChange={setTocView} /> : <span>目录</span>}
            <span className="toc-n">
              {tocCount} {tocUnit}
            </span>
            <TocLocate onClick={locateCurrent} />
            <button className="btn sm" onClick={() => setTocDocked(false)} title="取消固定目录">
              ✕
            </button>
          </div>
          <div className="toc-dock-body">
            <TocList
              view={tocView}
              toc={toc}
              chapters={chapters}
              itemClass="toc-item"
              activeSet={activeSet}
              resolve={resolveTocHref}
              onPick={pickToc}
              current={current}
              openChapter={openChapter}
              collapsed={tocCollapsed}
              onToggle={toggleToc}
            />
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
                pageTurns.onSettleEnd();
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
              page: see placeBand in `usePageTurns.ts`. */}
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
          {/* The tag hanging out of the page's top edge. It lives on the sheet
              rather than in the chrome on purpose: bookmark state has to be
              readable with the bars closed, and this is the thing a downward
              pull drags out. `height` is the only property the gesture writes,
              so React's class can own the resting state without a fight. */}
          <div
            className={`page-tag-wrap${pagesPerView === 2 ? ' left' : ''}${pageTagged ? ' on' : ''}`}
            ref={tagWrapRef}
            aria-hidden="true"
          >
            <div className="page-tag" ref={tagRef} />
            <span className="page-tag-label">{pageTagged ? '松手删除书签' : '松手添加书签'}</span>
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
              {hasNav ? <TocSeg view={tocView} onChange={setTocView} /> : <span>目录</span>}
              <span className="toc-n">
                {tocCount} {tocUnit}
              </span>
              <TocLocate onClick={locateCurrent} />
              <button className="btn sm" onClick={() => setTocOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              <TocList
                view={tocView}
                toc={toc}
                chapters={chapters}
                itemClass="drawer-item"
                activeSet={activeSet}
                resolve={resolveTocHref}
                onPick={pickToc}
                current={current}
                openChapter={openChapter}
                collapsed={tocCollapsed}
                onToggle={toggleToc}
              />
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
