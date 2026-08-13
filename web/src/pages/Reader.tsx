import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { api, Annotation, Book, Bookmark, Chapter } from '../api';
import { toast, toastError } from '../toast';

const FONT_KEY = 'epubmaker.fontSize';
const MODE_KEY = 'epubmaker.readMode';
const posKey = (id: string) => `epubmaker.pos.${id}`;

type ReadMode = 'scroll' | 'paged';
type PageIntent = { type: 'first' | 'last' | 'restore'; page?: number } | null;

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
  const locationUsedRef = useRef(false);

  /* ---- load book / chapters / persisted data ---- */
  useEffect(() => {
    (async () => {
      try {
        const [b, cs, prog, bms, anns] = await Promise.all([
          api.getBook(id),
          api.listChapters(id),
          api.getProgress(id),
          api.listBookmarks(id),
          api.listAnnotations(id),
        ]);
        setBook(b);
        setChapters(cs);
        setBookmarks(bms);
        setAnnotations(anns);

        const exists = (cid: string | undefined) => !!cid && cs.some((c) => c.id === cid);
        const target =
          (chapterId && exists(chapterId) && chapterId) ||
          (prog && exists(prog.chapterId) && prog.chapterId) ||
          cs[0]?.id ||
          null;
        if (prog && prog.chapterId === target) {
          pageIntentRef.current = { type: 'restore', page: prog.pageIndex };
        }
        const restorePage = (loc.state as { page?: number } | null)?.page;
        if (restorePage !== undefined && !locationUsedRef.current) {
          pageIntentRef.current = { type: 'restore', page: restorePage };
          locationUsedRef.current = true;
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

  /* ---- measure pages (paged mode) ---- */
  useEffect(() => {
    if (mode !== 'paged') return;
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      setStageWidth(stage.clientWidth);
      setStageHeight(stage.clientHeight);
    };
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    update();
    return () => ro.disconnect();
  }, [mode]);

  useLayoutEffect(() => {
    if (mode !== 'paged') return;
    measureAndLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, fontSize, mode, stageWidth]);

  function measureAndLayout() {
    const stage = stageRef.current;
    const col = columnsRef.current;
    if (!stage || !col) return;

    const MARGIN = 34;
    const GAP = 28;
    const PAD_X = 44;
    const PAD_Y = 24;
    const PAGE_RATIO = 0.72; // typical Chinese paperback width/height

    const availH = Math.max(240, stage.clientHeight - PAD_Y * 2);
    const sh = Math.min(Math.round(availH), 900);
    const sw = Math.round(sh * PAGE_RATIO);
    const cw = Math.max(160, sw - MARGIN * 2);
    const ch = sh - MARGIN * 2;

    const ppv = stage.clientWidth >= sw * 2 + GAP + PAD_X * 2 ? 2 : 1;

    setSheetWidth(sw);
    setSheetHeight(sh);
    setContentWidth(cw);
    setContentHeight(ch);
    setPageGap(GAP);
    setMarginPx(MARGIN);
    setPagesPerView(ppv);

    const columnGap = sw + GAP - cw; // = GAP + 2*MARGIN, aligns columns with sheets
    // Measure how many columns the content naturally fills at this geometry.
    col.style.width = 'auto';
    col.style.columnWidth = `${cw}px`;
    col.style.columnGap = `${columnGap}px`;
    col.style.height = `${ch}px`;
    const pc = Math.max(1, Math.ceil(col.scrollWidth / (cw + columnGap)));
    setPageCount(pc);
    col.style.width = `${pc * cw + (pc - 1) * columnGap}px`;

    const intent = pageIntentRef.current;
    let nextPage = 0;
    if (intent?.type === 'last') nextPage = pc - 1;
    else if (intent?.type === 'first') nextPage = 0;
    else if (intent?.type === 'restore') nextPage = Math.min(intent.page ?? 0, pc - 1);
    else nextPage = Math.min(pageIndex, pc - 1);
    // Align to spread boundary when using a two-page spread.
    if (ppv > 1 && nextPage > 0 && nextPage % ppv !== 0) {
      nextPage = Math.max(0, Math.min(pc - ppv, nextPage - (nextPage % ppv)));
    }
    setPageIndex(nextPage);
    pageIntentRef.current = null;
  }

  function scheduleMeasure() {
    requestAnimationFrame(() => measureAndLayout());
  }

  /* ---- progress persistence (paged mode) ---- */
  useEffect(() => {
    if (mode !== 'paged' || !current) return;
    const t = setTimeout(() => {
      api.saveProgress(id, current, pageIndex, pageCount).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [mode, current, pageIndex, pageCount, id]);

  const idx = chapters.findIndex((c) => c.id === current);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  const progressPct = chapters.length
    ? ((idx + (pageCount ? pageIndex / pageCount : 0)) / chapters.length) * 100
    : 0;

  /* ---- navigation ---- */
  function openChapter(cid: string, intent: PageIntent = { type: 'first' }) {
    setPopover(null);
    setSel(null);
    setBmOpen(false);
    setTocOpen(false);
    pageIntentRef.current = intent;
    setCurrent(cid);
  }

  const turnStep = Math.max(1, pagesPerView);

  function turn(delta: number) {
    const step = turnStep;
    if (delta > 0) {
      if (pageIndex + step < pageCount) setPageIndex(pageIndex + step);
      else if (next) openChapter(next.id, { type: 'first' });
    } else {
      if (pageIndex - step >= 0) setPageIndex(pageIndex - step);
      else if (prev) openChapter(prev.id, { type: 'last' });
    }
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') {
        setPopover(null);
        setSel(null);
        setBmOpen(false);
        setAnnOpen(false);
        setTocOpen(false);
        return;
      }
      if (mode === 'paged') {
        if (e.key === 'ArrowLeft') turn(-1);
        if (e.key === 'ArrowRight') turn(1);
      } else {
        if (e.key === 'ArrowLeft' && prev) setCurrent(prev.id);
        if (e.key === 'ArrowRight' && next) setCurrent(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, prev, next, pageIndex, pageCount]);

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
      const a = await api.addAnnotation(id, current, sel.start, sel.end, sel.text, color, '');
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
      const b = await api.addBookmark(id, current, pageIndex, '');
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
    openChapter(b.chapterId, { type: 'restore', page: b.anchor });
  }

  function jumpAnnotation(a: Annotation) {
    openChapter(a.chapterId, { type: 'first' });
    setAnnOpen(false);
  }

  /* ---- render ---- */
  if (loading) return <div className="loading">加载中…</div>;
  if (!book) return <div className="page empty">书籍不存在</div>;

  if (mode === 'scroll') {
    return (
      <div className="reader">
        <aside className="toc">
          <div className="toc-head">目录 · {chapters.length} 章</div>
          {chapters.map((c, i) => (
            <button
              key={c.id}
              className={`toc-item${c.id === current ? ' active' : ''}`}
              onClick={() => openChapter(c.id)}
              title={c.title}
            >
              <span className="num">{String(i + 1).padStart(2, '0')}</span>
              {c.title}
            </button>
          ))}
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
  const innerWidth = pageCount > 0 ? pageCount * sheetWidth + (pageCount - 1) * pageGap : 0;
  const spreadWidth = innerWidth + 2 * marginPx;
  const spreadHeight = sheetHeight + 2 * marginPx;
  const viewWidth = Math.max(sheetWidth, pagesPerView * sheetWidth + (pagesPerView - 1) * pageGap);
  const spreadLeft = Math.round((stageWidth - viewWidth) / 2);
  const spreadTop = Math.round((stageHeight - sheetHeight) / 2);
  const columnGap = sheetWidth + pageGap - contentWidth;
  const geometryReady = sheetWidth > 0 && contentWidth > 0;

  return (
    <div className="reader reader-paged">
      <div className="reader-stage" ref={stageRef} onClick={onStageClick}>
        <div
          className={`reader-spread${geometryReady ? ' is-ready' : ''}`}
          ref={spreadRef}
          style={{
            left: spreadLeft,
            top: spreadTop,
            width: Math.max(0, spreadWidth),
            height: Math.max(0, spreadHeight),
            transform: `translate3d(-${pageIndex * (sheetWidth + pageGap)}px, 0, 0)`,
          }}
        >
          {geometryReady &&
            Array.from({ length: pageCount }).map((_, i) => (
              <div
                key={i}
                className={`page-sheet${i % 2 === 0 ? ' left' : ' right'}`}
                style={{
                  left: marginPx + i * (sheetWidth + pageGap),
                  width: sheetWidth,
                  height: sheetHeight,
                }}
              />
            ))}
          <div
            className="reader-columns"
            ref={columnsRef}
            style={{
              left: marginPx,
              top: marginPx,
              width: pageCount > 0 ? pageCount * contentWidth + (pageCount - 1) * columnGap : 0,
              height: Math.max(0, contentHeight),
              columnWidth: contentWidth,
              columnGap: columnGap,
            }}
          >
            <div className="reader-content" ref={contentRef} style={{ fontSize }} />
          </div>
        </div>
      </div>

      {chromeOpen && (
        <>
          <div className="reader-chrome top">
            <button className="btn sm" onClick={() => nav('/')}>
              ← 书架
            </button>
            <div className="crumb">
              <strong>{book.title}</strong>
              <span>·</span>
              <span>{book.author || '未知作者'}</span>
            </div>
            <span style={{ flex: 1 }} />
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

          <div className="reader-chrome bottom">
            <button className="btn" disabled={pageIndex <= 0 && !prev} onClick={() => turn(-1)}>
              ← 上一页
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              第 {pageIndex + 1} / {pageCount} 页
            </span>
            <button className="btn" disabled={pageIndex >= pageCount - 1 && !next} onClick={() => turn(1)}>
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
              <button className="btn sm" onClick={() => setTocOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {chapters.map((c, i) => (
                <button
                  key={c.id}
                  className={`drawer-item${c.id === current ? ' active' : ''}`}
                  onClick={() => openChapter(c.id)}
                >
                  <span className="num">{String(i + 1).padStart(2, '0')}</span>
                  {c.title}
                </button>
              ))}
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
                          第 {b.anchor + 1} 页
                          {b.label ? ' · ' + b.label : ''}
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
