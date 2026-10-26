import {
  DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useBackClose } from '../backNav';
import {
  api,
  Book,
  DictStatus,
  downloadDataUrl,
  hasNativeDialogs,
  pickEpubFiles,
  pickImageFile,
} from '../api';
import { canResolveDropPaths, onDroppedFiles } from '../filedrop';
import { toast, toastError } from '../toast';

// The shelf survives its own unmount. Opening a book, checking the notebook or
// going to the trash all tear this page down, and rebuilding it from scratch
// means a "加载中…" line where the grid was and then every cover decoding
// again — a full-screen flash for data that never changed. Caching the last
// answer lets the page paint that answer immediately and refresh underneath.
//
// Covers arrive as data URLs inside the book list, so this cache also keeps
// those strings (a few hundred KB at most) alive across navigations.
type ShelfCache = {
  books: Book[];
  dict: DictStatus | null;
};
let shelfCache: ShelfCache | null = null;

function cacheShelf(patch: Partial<ShelfCache>) {
  shelfCache = { books: [], dict: null, ...shelfCache, ...patch };
}

/**
 * Whether a fresh shelf answer says the same thing as the one on screen.
 *
 * Every field a card draws is checked, covers included: `thumbUrl` changes when
 * a book gets a new jacket, which is exactly the case that must repaint. Sizes
 * here are tens of KB, so the comparisons are microseconds next to a re-render.
 */
function sameShelf(a: Book[], b: Book[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.title !== y.title ||
      x.author !== y.author ||
      x.updatedAt !== y.updatedAt ||
      x.chapterCount !== y.chapterCount ||
      x.thumbUrl !== y.thumbUrl ||
      x.coverUrl !== y.coverUrl
    ) {
      return false;
    }
  }
  return true;
}

/* ---- shelf ordering + paging (phone) ---- */

const SORT_KEY = 'epubmaker.shelfSort';
type ShelfSort = 'default' | 'title' | 'author' | 'created';
const SORT_OPTIONS: Array<{ id: ShelfSort; label: string }> = [
  { id: 'default', label: '默认排序' },
  { id: 'title', label: '按书名' },
  { id: 'author', label: '按作者' },
  { id: 'created', label: '按添加时间' },
];

// How many cards render before the reader has to scroll for more. The backend
// returns the whole shelf in one query (local SQLite), so paging is purely a
// rendering budget: 30 covers as base64 data URLs is real decode work, and a
// phone should not pay it up front.
const PAGE_SIZE = 12;

// How long the card stays pressed before the reader opens. Short enough to read
// as an acknowledgement of the tap rather than as lag; long enough for the
// press-in transition to actually be painted.
const PRESS_MS = 130;

// A hold that opened the menu leaves exactly one click behind when the finger
// lifts. That click is the tail of the gesture, not a tap on anything: ignoring
// it needs a window long enough to cover the browser's synth delay (~10-40ms)
// and short enough that a real tap right after the release still counts.
const HOLD_CLICK_MS = 200;

// Same rule as the reader: a device whose primary pointer cannot hover is a
// touch device, and a touchscreen laptop with a mouse stays "desktop".
function isTouchPrimary(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(any-pointer: fine)').matches) return false;
  return (
    window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches
  );
}

// The press animation is only worth its delay when the reader can see it.
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function Library() {
  const [books, setBooks] = useState<Book[]>(() => shelfCache?.books ?? []);
  const [keyword, setKeyword] = useState('');
  // Only a shelf with nothing to show is "loading"; a refresh must never blank
  // what is already on screen.
  const [loading, setLoading] = useState(shelfCache === null);
  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState(false);

  // Local ECDICT dictionary: imported from a csv chosen on disk. Without it the
  // reader's lookup is disabled, so its state is surfaced here.
  const [dict, setDict] = useState<DictStatus | null>(() => shelfCache?.dict ?? null);
  const [dictBusy, setDictBusy] = useState(false);
  const nav = useNavigate();
  // A phone has no native file dialog and cannot receive an OS file drop, so
  // the import controls have to point at something that works there.
  const desktop = hasNativeDialogs();
  // Phone layout: the search field, sort and the import entry collapse behind
  // header icons, and per-book actions live in a bottom sheet opened by a
  // long-press on the cover.
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [menuBook, setMenuBook] = useState<Book | null>(null);
  // The phone's metadata editor: title / author / tags / cover only. The
  // desktop edit page stays the place for chapter surgery.
  const [editBook, setEditBook] = useState<Book | null>(null);
  const [editForm, setEditForm] = useState({ title: '', author: '', tags: '' });
  const [editBusy, setEditBusy] = useState(false);

  // Hardware back closes one sheet per press instead of leaving the shelf.
  useBackClose(importOpen, () => setImportOpen(false));
  useBackClose(sortOpen, () => setSortOpen(false));
  useBackClose(!!menuBook, () => setMenuBook(null));
  useBackClose(!!editBook, () => setEditBook(null));
  // Shelf progress badges (bookId -> 0..1), refreshed with the shelf.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<ShelfSort>(
    () => (localStorage.getItem(SORT_KEY) as ShelfSort) || 'default',
  );
  // How many cards are currently rendered (paging, see PAGE_SIZE). Paging is a
  // phone affordance only: the desktop always painted the whole shelf, and the
  // desktop regressions (drop / shelf) pin that — import must be visible
  // without a scroll.
  const [touch] = useState(isTouchPrimary);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => localStorage.setItem(SORT_KEY, sort), [sort]);

  // Ordering is a display concern: the backend returns the shelf in its own
  // order (默认), everything else sorts client-side. localeCompare with the
  // Chinese locale keeps 「书名」 ordering sane for mixed CJK/Latin shelves.
  const sortedBooks = useMemo(() => {
    if (sort === 'default') return books;
    const arr = [...books];
    if (sort === 'title') arr.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    else if (sort === 'author')
      arr.sort((a, b) => (a.author || '未知作者').localeCompare(b.author || '未知作者', 'zh'));
    else arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return arr;
  }, [books, sort]);
  const visibleBooks = touch ? sortedBooks.slice(0, visibleCount) : sortedBooks;
  const totalRef = useRef(sortedBooks.length);
  totalRef.current = sortedBooks.length;

  // A fresh keyword or order restarts paging — otherwise the reader could be
  // parked on page 4 of a list that just changed underneath them.
  useEffect(() => {
    if (touch) setVisibleCount(PAGE_SIZE);
  }, [keyword, sort, touch]);

  // Load more when the sentinel drifts into view. The scroll container is
  // .lib-scroll (the only scroller on this page), the sentinel renders just
  // below the grid and only while cards remain.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!touch) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((n) => Math.min(totalRef.current, n + PAGE_SIZE));
        }
      },
      { root: el.closest('.lib-scroll'), rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [keyword, sort, books, loading, touch]);

  /* ---- long-press: the phone's per-book menu ----
     A 500ms hold anywhere on the card opens the sheet; any movement cancels it
     (it is a scroll, not a hold), and the click that ends the gesture is
     swallowed so the sheet does not immediately open the reader. */
  const longPressRef = useRef<{ timer: number | null; firedAt: number }>({
    timer: null,
    firedAt: 0,
  });
  // Timestamps, not booleans: the sheet ends up under the thumb that opened it,
  // so the release's click lands on the sheet-mask rather than on the card.
  // A stale "fired" flag would then swallow the reader's next real tap.
  const menuReleasedAt = useRef(0);

  function startLongPress(b: Book) {
    if (!isTouchPrimary()) return;
    cancelLongPress();
    longPressRef.current.firedAt = 0;
    longPressRef.current.timer = window.setTimeout(() => {
      longPressRef.current.timer = null;
      longPressRef.current.firedAt = Date.now();
      setMenuBook(b);
      try {
        navigator.vibrate?.(10);
      } catch {
        /* vibration is a nicety, not a requirement */
      }
    }, 500);
  }

  function cancelLongPress() {
    const lp = longPressRef.current;
    if (lp.timer !== null) {
      window.clearTimeout(lp.timer);
      lp.timer = null;
    }
  }

  // Lifting the finger after a hold leaves a click behind. Only a hold that
  // actually opened the menu produces one worth ignoring, and only the click
  // that follows immediately — hence a timestamp, not a sticky flag.
  function endLongPress() {
    if (longPressRef.current.firedAt) menuReleasedAt.current = Date.now();
    cancelLongPress();
  }

  // The long-press gesture belongs to the whole card face, not just the cover:
  // a thumb lands on the title or the author line just as often. The card root
  // carries these handlers; the action buttons inside it are excluded.
  function holdProps(b: Book) {
    return {
      onTouchStart: () => startLongPress(b),
      onTouchMove: cancelLongPress,
      onTouchEnd: endLongPress,
      onTouchCancel: cancelLongPress,
      onContextMenu: (e: { preventDefault: () => void }) => {
        // The WebView's own long-press menu must not compete with ours
        // (touch devices only; desktop keeps text menus).
        if (isTouchPrimary()) e.preventDefault();
      },
    };
  }

  /* ---- tap to open: the whole card, with a press before the page swaps ----
     Opening used to live on the cover alone, so a thumb aimed at the title or
     the author line hit dead space and the card merely hovered. Every pixel of
     the card is the open target now. The press is a "button down" frame held
     for PRESS_MS: navigation tears the card down, so without it the tap gets no
     visible answer at all. */
  const [pressedBook, setPressedBook] = useState<string | null>(null);
  const [reducedMotion] = useState(prefersReducedMotion);
  const pressRef = useRef<number | null>(null);

  function openBook(b: Book) {
    // The click that ends a hold belongs to the sheet it already opened. It
    // arrives right after the finger lifts, so the release is the anchor.
    if (Date.now() - menuReleasedAt.current < HOLD_CLICK_MS) return;
    // One press, one navigation: a double tap must not push two history
    // entries for the same book.
    if (pressRef.current !== null) return;
    const finish = () => {
      pressRef.current = null;
      // The pressed state is deliberately not cleared here — the unmount is
      // the release, so the card never snaps back to full size on its way out.
      nav(`/books/${b.id}/read`);
    };
    if (reducedMotion) {
      finish();
      return;
    }
    setPressedBook(b.id);
    pressRef.current = window.setTimeout(finish, PRESS_MS);
  }

  // A card can be unmounted mid-press (the shelf reloads, the reader opens from
  // another entry point); the pending navigation must not fire into a dead page.
  useEffect(
    () => () => {
      if (pressRef.current !== null) window.clearTimeout(pressRef.current);
    },
    [],
  );

  const load = useCallback(async (kw?: string) => {
    try {
      const next = await api.listBooks(kw);
      // Coming back to the shelf re-fetches unconditionally, and the answer is
      // usually the identical list as fresh object identities. Replacing it then
      // repaints twelve cards and re-decodes twelve thumbnails for nothing —
      // measured as the tail of the "delay" after leaving a book. Keep the old
      // array when nothing actually changed.
      setBooks((prev) => (sameShelf(prev, next) ? prev : next));
      // Only the unfiltered shelf is worth remembering: a search result shown
      // on the next visit, before the keyword is even typed, would be wrong.
      if (!kw) cacheShelf({ books: next });
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Books can also arrive while the user is elsewhere: a system-share
    // import (App.tsx) or a Wi-Fi transfer announces itself with this event.
    const onImported = () => void load();
    window.addEventListener('epubmaker:imported', onImported);
    api
      .dictStatus()
      .then((d) => {
        setDict(d);
        cacheShelf({ dict: d });
      })
      .catch(() => undefined);
    // Progress badges are display sugar: a miss (old backend, mock) just
    // leaves the shelf without them.
    api
      .listBookProgress()
      .then((rows) => {
        const m: Record<string, number> = {};
        for (const r of rows ?? []) m[r.bookId] = r.percent;
        setProgress(m);
      })
      .catch(() => undefined);
    return () => window.removeEventListener('epubmaker:imported', onImported);
  }, [load]);

  // Search is debounced, and the first render is skipped: the effect above has
  // already asked for the full shelf, and firing both meant two renders of the
  // same list on every visit.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => void load(keyword.trim() || undefined), 260);
    return () => clearTimeout(t);
  }, [keyword, load]);

  // Opens the file picker (native dialog on desktop, SAF via the v3 runtime on
  // the phone) and imports the chosen files via bindings.
  async function pickAndImport() {
    try {
      const paths = await pickEpubFiles();
      if (!paths?.length) return; // cancelled
      await importPaths(paths);
    } catch (e) {
      toastError(e);
    }
  }

  // Both entry points end here: the button, and a file dragged from Explorer.
  // A drop only ever reaches this point as filesystem paths — the webview drop
  // event carries File objects without one — so this is the only way an import
  // can read the book.
  async function importPaths(paths: string[]) {
    // A second drop while a book is still being parsed would interleave two
    // imports on the same list; the first one is already shown as busy.
    if (importing) {
      toast('正在导入，请稍候', 'info');
      return;
    }
    const epub = paths.filter((p) => /\.epub$/i.test(p));
    const ignored = paths.length - epub.length;
    if (!epub.length) {
      toast(paths.length === 1 ? '只能导入 .epub 文件' : '拖入的文件里没有 .epub', 'error');
      return;
    }
    setImporting(true);
    try {
      const res = await api.importPaths(epub);
      if (res.books.length > 0) toast(`成功导入 ${res.books.length} 本书籍`, 'success');
      if (ignored > 0) toast(`已跳过 ${ignored} 个非 EPUB 文件`, 'info');
      if (res.duplicates?.length) toast(`跳过重复：\n${res.duplicates.join('\n')}`, 'info', 6000);
      if (res.errors?.length) toast(res.errors.join('\n'), 'error', 6000);
      // Put the new books on the shelf straight away and let the refresh
      // confirm them: reloading first would empty the grid, which is the flash
      // this page is trying to avoid — and an import is when it hurts most,
      // because the shelf is exactly what the reader is watching.
      const added = new Set(res.books.map((b) => b.id));
      setBooks((prev) => [...res.books, ...prev.filter((b) => !added.has(b.id))]);
      await load(keyword.trim() || undefined);
    } catch (e) {
      toastError(e);
    } finally {
      setImporting(false);
    }
  }

  // Dropped files arrive through the native bridge, asynchronously, from
  // outside React — so the handler is kept in a ref to always see the current
  // keyword instead of the one captured when the subscription was made.
  const importRef = useRef<(paths: string[]) => void>(() => undefined);
  importRef.current = (paths) => void importPaths(paths);
  useEffect(() => onDroppedFiles((paths) => importRef.current(paths)), []);

  // Dragging is counted, not flagged: moving over a child fires `dragleave` on
  // the parent, and a boolean makes the highlight flicker on every card.
  const dragDepth = useRef(0);
  // A drag with files in it is an OS file, not an element being dragged inside
  // the page; only the former can be imported.
  const isFileDrag = (e: ReactDragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  async function exportBook(book: Book) {
    try {
      const { filename, dataUrl } = await api.exportBook(book.id);
      downloadDataUrl(filename, dataUrl);
    } catch (e) {
      toastError(e);
    }
  }

  // Opens the native csv picker and builds the local dictionary. This blocks
  // for a few seconds on the full 770k-entry ECDICT export.
  async function doImportDict() {
    if (
      dict?.installed &&
      !confirm(`已安装词库（${dict.entries} 条）。重新导入会覆盖现有词库，继续？`)
    ) {
      return;
    }
    try {
      const path = await api.selectDictFile();
      if (!path) return;
      setDictBusy(true);
      const res = await api.dictImport(path);
      toast(`词库导入完成：${res.entries} 条`, 'success');
      const status = await api.dictStatus();
      setDict(status);
      cacheShelf({ dict: status });
    } catch (e) {
      toastError(e);
    } finally {
      setDictBusy(false);
    }
  }

  async function remove(book: Book) {
    if (!confirm(`确定删除《${book.title}》？该书将移入回收站，可随时恢复。`)) return;
    try {
      await api.deleteBook(book.id);
      toast('已移入回收站', 'success');
      // Drop the card first so the click feels immediate; the reload only puts
      // the rest of the shelf back in order.
      setBooks((prev) => prev.filter((b) => b.id !== book.id));
      await load(keyword.trim() || undefined);
    } catch (e) {
      toastError(e);
    }
  }

  /* ----------------------- phone metadata editor ----------------------- */

  function openEdit(b: Book) {
    setMenuBook(null);
    setEditBook(b);
    setEditForm({
      title: b.title,
      author: b.author || '',
      tags: (b.tags || []).join(', '),
    });
  }

  // Tags are free text on the phone keyboard: split on the separators people
  // actually type (Chinese comma/ enumeration mark included).
  function parseTagInput(s: string): string[] {
    return s
      .split(/[,，、;；]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async function saveEdit() {
    if (!editBook || editBusy) return;
    setEditBusy(true);
    try {
      await api.updateBook(editBook.id, {
        title: editForm.title.trim() || editBook.title,
        author: editForm.author.trim(),
        tags: parseTagInput(editForm.tags),
      });
      toast('已保存', 'success');
      setEditBook(null);
      await load(keyword.trim() || undefined);
    } catch (e) {
      toastError(e);
    } finally {
      setEditBusy(false);
    }
  }

  async function changeCover() {
    if (!editBook || editBusy) return;
    try {
      const path = await pickImageFile();
      if (!path) return;
      setEditBusy(true);
      // Uploading only stores the image as an asset — the book still points at
      // its old cover, so the shelf kept painting the old one. Point it at the
      // new href (with whatever else was typed in the form, so a cover change
      // does not throw the other edits away).
      const up = await api.uploadCoverFromPath(editBook.id, path);
      await api.updateBook(editBook.id, {
        title: editForm.title.trim() || editBook.title,
        author: editForm.author.trim(),
        tags: parseTagInput(editForm.tags),
        coverHref: up.href,
      });
      toast('封面已更新', 'success');
      setEditBook(null);
      await load(keyword.trim() || undefined);
    } catch (e) {
      toastError(e);
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <div
      className={`page library${over ? ' dropping' : ''}`}
      // The whole shelf is the drop target, not just the dashed box: a file
      // dragged over a book cover is aimed at the same place in the reader's
      // head, and refusing it there would look broken.
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        // Without this the webview opens the file instead of dropping it.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setOver(false);
        // Native bridge live: the same drop arrives with real paths, and
        // importing here as well would import twice. Otherwise (a plain browser)
        // there is no path to read, so fall back to the picker.
        if (!canResolveDropPaths()) void pickAndImport();
      }}
    >
      <div className={`lib-head${searchOpen ? ' search-open' : ''}`}>
        <h1>书架</h1>
        <span className="tag">{books.length} 本</span>
        <span style={{ flex: 1 }} />
        {/* 回收站 lives under「我的」on the phone; the class only hides it in
            the mobile media query, the desktop top bar keeps it here. */}
        <Link className="btn ghost desk-only" to="/trash">
          回收站
        </Link>
        {desktop ? (
          <button
            className="btn ghost"
            disabled={dictBusy}
            title={dict?.installed ? `词库路径：${dict.path}` : '尚未安装词库，查词功能不可用'}
            onClick={() => void doImportDict()}
          >
            {dictBusy ? '导入词库…' : dict?.installed ? `词库 ${dict.entries} 条` : '导入词库'}
          </button>
        ) : null}
        <button
          className="btn ghost lib-search-toggle"
          aria-label={searchOpen ? '收起搜索' : '搜索'}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.6" cy="8.6" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M13.2 13.2 L17.4 17.4"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {/* 排序 and ＋: phone-only header icons (the desktop header has the
            search input and the 导入 EPUB button in their place). */}
        <button
          className="btn ghost lib-sort-toggle"
          aria-label="排序方式"
          onClick={() => setSortOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M3 6h14M3 10h10M3 14h6"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className="btn ghost lib-plus-toggle"
          aria-label="添加书籍"
          onClick={() => setImportOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M10 4v12M4 10h12"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <input
          className="input lib-search-input"
          style={{ width: 220 }}
          placeholder="搜索书名或作者…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        {desktop ? (
          <button
            className="btn primary import-btn"
            disabled={importing}
            onClick={() => void pickAndImport()}
          >
            {importing ? '导入中…' : '导入 EPUB'}
          </button>
        ) : null}
      </div>

      <div className="lib-scroll">
        {desktop ? (
          <div className={`dropzone${over ? ' over' : ''}`} onClick={() => void pickAndImport()}>
            {importing ? '正在解析 EPUB…' : '把 .epub 文件拖到这里，或点击选择文件（支持多选）'}
          </div>
        ) : null}
        {/* Phone: no hint bar. Drag-import cannot happen there and the ＋ in
            the header (and the FAB) already say where import lives. */}

        {loading ? (
          <div className="loading">加载中…</div>
        ) : books.length === 0 ? (
          <div className="empty">
            <p style={{ fontSize: 15, marginBottom: 6 }}>书架还是空的</p>
            <p>导入第一本 EPUB 开始整理吧</p>
          </div>
        ) : (
          <div className="grid">
            {visibleBooks.map((b) => {
              const pct = progress[b.id];
              const pctLabel = pct > 0 ? `${Math.min(100, Math.round(pct * 100))}%` : null;
              return (
                <div
                  className={`book-card${pressedBook === b.id ? ' pressing' : ''}`}
                  key={b.id}
                  // The card is the open target, not just the cover: title,
                  // author, badge and the padding around them all open the book.
                  onClick={() => openBook(b)}
                  {...holdProps(b)}
                >
                  <div className="cover">
                    {/* The thumbnail is what the list carries; the full cover is
                        only here for books whose format cannot be thumbnailed.
                        Cards draw at ~120×170, so the difference is invisible —
                        but it is the difference between 20 KB and 400 KB of
                        work per card on the way back from a book. */}
                    {b.thumbUrl || b.coverUrl ? (
                      <img
                        src={b.thumbUrl || b.coverUrl!}
                        alt={b.title}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="placeholder">{b.title}</div>
                    )}
                  </div>
                  <div className="book-body">
                    <div className="book-title" title={b.title}>
                      {b.title}
                    </div>
                    <div className="book-meta book-meta-row">
                      <span className="book-author">{b.author || '未知作者'}</span>
                      {/* The badge is fixed-size and sits at the line's end; the
                          author span shrinks instead of ever covering it. */}
                      {pctLabel && <span className="book-progress">{pctLabel}</span>}
                    </div>
                  </div>
                  {/* These go somewhere of their own — 整理 / 拆分 / 导出 /
                      删除 must not also be read as a tap on the card. */}
                  <div className="book-actions" onClick={(e) => e.stopPropagation()}>
                    <Link className="btn sm" to={`/books/${b.id}/read`}>
                      阅读
                    </Link>
                    <Link className="btn sm" to={`/books/${b.id}/edit`}>
                      整理
                    </Link>
                    <Link className="btn sm" to={`/books/${b.id}/split`}>
                      拆分
                    </Link>
                    <button className="btn sm" onClick={() => void exportBook(b)}>
                      导出
                    </button>
                    <button className="btn sm danger" onClick={() => void remove(b)}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {visibleBooks.length < sortedBooks.length && (
          <div className="shelf-sentinel" ref={sentinelRef}>
            加载更多…
          </div>
        )}
      </div>

      {importOpen && (
        <div className="sheet-mask" onClick={() => setImportOpen(false)}>
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">导入书籍</div>
            {/* Both hosts can pick files now: the phone routes the SAF document
                picker through the v3 runtime, so local import is offered there
                next to WebDAV. */}
            <button
              className="sheet-item"
              disabled={importing}
              onClick={() => {
                setImportOpen(false);
                void pickAndImport();
              }}
            >
              {importing ? '导入中…' : '从本地文件导入'}
            </button>
            <Link className="sheet-item" to="/webdav" onClick={() => setImportOpen(false)}>
              从 WebDAV 导入
            </Link>
            <button className="sheet-item cancel" onClick={() => setImportOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Shelf ordering. Persisted; the phone reaches it from the header
          sort icon. */}
      {sortOpen && (
        <div className="sheet-mask" onClick={() => setSortOpen(false)}>
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">排序方式</div>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.id}
                className={`sheet-item${sort === o.id ? ' sort-on' : ''}`}
                onClick={() => {
                  setSort(o.id);
                  setSortOpen(false);
                }}
              >
                {sort === o.id ? '✓ ' : ''}
                {o.label}
              </button>
            ))}
            <button className="sheet-item cancel" onClick={() => setSortOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* The phone's per-book menu, reached by long-pressing the cover, title
          or author line. 编辑 opens the phone-sized metadata editor (title /
          author / tags / cover only); the desktop edit page stays a desktop
          job. */}
      {menuBook && (
        <div
          className="sheet-mask"
          onClick={() => {
            // The release that ended the long-press clicks the mask it landed
            // on; that is not a request to close the menu.
            if (Date.now() - menuReleasedAt.current < HOLD_CLICK_MS) return;
            setMenuBook(null);
          }}
        >
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{menuBook.title}</div>
            <button className="sheet-item" onClick={() => openEdit(menuBook)}>
              编辑（书名 / 作者 / 标签 / 封面）
            </button>
            <button
              className="sheet-item danger"
              onClick={() => {
                const bk = menuBook;
                setMenuBook(null);
                void remove(bk);
              }}
            >
              删除
            </button>
            <button className="sheet-item cancel" onClick={() => setMenuBook(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* The phone-sized metadata editor. Four fields, thumb-sized rows, and
          no chapter tooling — that is what the desktop edit page is for. */}
      {editBook && (
        <div className="sheet-mask" onClick={() => (editBusy ? undefined : setEditBook(null))}>
          <div className="sheet edit-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">编辑书籍</div>
            <label className="edit-field">
              <span>书名</span>
              <input
                className="input"
                value={editForm.title}
                maxLength={200}
                onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
              />
            </label>
            <label className="edit-field">
              <span>作者</span>
              <input
                className="input"
                value={editForm.author}
                maxLength={120}
                onChange={(e) => setEditForm((f) => ({ ...f, author: e.target.value }))}
              />
            </label>
            <label className="edit-field">
              <span>标签（用逗号分隔）</span>
              <input
                className="input"
                value={editForm.tags}
                maxLength={200}
                placeholder="如：小说, 历史"
                onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))}
              />
            </label>
            <div className="edit-cover-row">
              <div className="edit-cover">
                {editBook.thumbUrl || editBook.coverUrl ? (
                  <img src={editBook.thumbUrl || editBook.coverUrl!} alt="" />
                ) : (
                  <span>{editBook.title.slice(0, 2)}</span>
                )}
              </div>
              <button className="btn ghost" disabled={editBusy} onClick={() => void changeCover()}>
                {editBusy ? '处理中…' : '更换封面'}
              </button>
            </div>
            <div className="edit-actions">
              <button className="btn ghost" disabled={editBusy} onClick={() => setEditBook(null)}>
                取消
              </button>
              <button className="btn primary" disabled={editBusy} onClick={() => void saveEdit()}>
                {editBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
