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
import { api, Book, DictStatus, isDesktopHost, pickEpubFiles, pickImageFile, Shelf } from '../api';
import { isTouchPrimary, prefersReducedMotion } from '../device';
import { exportBookToHost } from '../exportEpub';
import { canResolveDropPaths, onDroppedFiles } from '../filedrop';
import { currentShelfId as readShelfId, DEFAULT_SHELF_ID, rememberShelfId } from '../shelfState';
import { toast, toastError } from '../toast';

// The shelf survives its own unmount. Opening a book, checking the notebook or
// going to the trash all tear this page down, and rebuilding it from scratch
// means a "加载中…" line where the grid was and then every cover decoding
// again — a full-screen flash for data that never changed. Caching the last
// answer lets the page paint that answer immediately and refresh underneath.
//
// Covers arrive as data URLs inside the book list, so this cache also keeps
// those strings (a few hundred KB at most) alive across navigations.
//
// It is keyed by shelf. Books of another shelf must never be painted while this
// one loads: that is not a flicker, it is the shelf showing what it is supposed
// to be hiding.
type ShelfCache = {
  shelfId: string;
  books: Book[];
  dict: DictStatus | null;
};
let shelfCache: ShelfCache | null = null;

function cacheShelf(patch: Partial<ShelfCache>) {
  shelfCache = { shelfId: DEFAULT_SHELF_ID, books: [], dict: null, ...shelfCache, ...patch };
}

function cachedBooks(shelfId: string): Book[] | null {
  return shelfCache && shelfCache.shelfId === shelfId ? shelfCache.books : null;
}

/**
 * The create / rename / password form.
 *
 * A sheet replaces the one it was opened from instead of stacking on top of it:
 * two bottom sheets sit at the same edge, so the lower one either covers the
 * form's input (the tap lands on a button of the sheet underneath and no
 * keyboard ever appears) or peeks out above it. `returnTo` is therefore part of
 * the state, not a callback: 取消 has to know which sheet to put back.
 */
type ShelfDialog =
  | { kind: 'create'; returnTo: 'shelf' | 'move' }
  | { kind: 'rename'; shelf: Shelf }
  | { kind: 'password'; shelf: Shelf };

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
      x.coverUrl !== y.coverUrl ||
      // Tags draw on the card and drive the chips filter; a re-tagged book
      // must repaint (arrays are tiny, so string compare is fine).
      JSON.stringify(x.tags ?? []) !== JSON.stringify(y.tags ?? [])
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

const SORT_DIR_KEY = 'epubmaker.shelfSortDir';
type SortDir = 'asc' | 'desc';
// Natural direction per key: 书名/作者 read A→Z, 添加时间 shows the newest
// book first (that was the only direction before this existed, so shelves
// sorted by time must not flip for users who never touch the toggle).
// 'default' is the backend's own order — it has no direction at all.
const DEFAULT_DIR: Record<ShelfSort, SortDir> = {
  default: 'asc',
  title: 'asc',
  author: 'asc',
  created: 'desc',
};

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

// How long the app may sit in the background before the shelves it opened are
// locked again. Below this a switch back to the browser tab feels like the same
// session; above it the phone has been somewhere else, possibly in someone
// else's hand.
const LOCK_AFTER_MS = 5 * 60 * 1000;

export default function Library() {
  // Which shelf this page is showing. Read from disk so the app comes back to
  // the shelf it was left on; an id the backend no longer knows is corrected by
  // loadShelves below.
  const [shelfId, setShelfId] = useState<string>(readShelfId);
  // The remembered answer has to belong to this shelf, or the grid would paint
  // another shelf's books while this one loads.
  const [books, setBooks] = useState<Book[]>(() => cachedBooks(readShelfId()) ?? []);
  const [keyword, setKeyword] = useState('');
  // Only a shelf with nothing to show is "loading"; a refresh must never blank
  // what is already on screen.
  const [loading, setLoading] = useState(() => cachedBooks(readShelfId()) === null);
  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState(false);

  // Every shelf, with its size and whether it still needs its password.
  const [shelves, setShelves] = useState<Shelf[]>([]);
  // The switcher sheet, the ⋯ actions for one shelf, and the create / rename /
  // password form. One of them is open at a time, all of them are bottom sheets.
  const [shelfSheet, setShelfSheet] = useState(false);
  const [shelfMenu, setShelfMenu] = useState<Shelf | null>(null);
  const [shelfDialog, setShelfDialog] = useState<ShelfDialog | null>(null);
  const [shelfForm, setShelfForm] = useState({ name: '', oldPw: '', newPw: '' });
  const [shelfBusy, setShelfBusy] = useState(false);
  // A shelf whose password is being asked for, and what to do once it is given:
  // switch to it, or move the selection into it.
  const [unlockTarget, setUnlockTarget] = useState<{ shelf: Shelf; then: 'open' | 'move' } | null>(
    null,
  );

  // Selection mode (null = off): the batch move starts here. Long-press on a
  // card opens the per-book sheet on a phone, so multi-select is entered from
  // that sheet — the header has no room for a fourth icon at 360px.
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  // Local ECDICT dictionary: imported from a csv chosen on disk. Without it the
  // reader's lookup is disabled, so its state is surfaced here.
  const [dict, setDict] = useState<DictStatus | null>(() => shelfCache?.dict ?? null);
  const [dictBusy, setDictBusy] = useState(false);
  const nav = useNavigate();
  // A phone has no native file dialog and cannot receive an OS file drop, so
  // the import controls have to point at something that works there.
  const desktop = isDesktopHost();
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
  useBackClose(shelfSheet, () => setShelfSheet(false));
  useBackClose(!!shelfMenu, () => setShelfMenu(null));
  useBackClose(!!shelfDialog, () => closeShelfDialog(shelfDialog));
  useBackClose(moveOpen, () => setMoveOpen(false));
  useBackClose(!!unlockTarget, () => setUnlockTarget(null));
  // Shelf progress badges (bookId -> 0..1), refreshed with the shelf.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<ShelfSort>(
    () => (localStorage.getItem(SORT_KEY) as ShelfSort) || 'default',
  );
  // Direction (顺序/倒序). Stored only once the user picks one explicitly;
  // until then every key falls back to its natural direction, so upgrading
  // users keep the ordering they already had. Picking a different sort key
  // clears the override — each key starts at its natural direction again.
  const [dirOverride, setDirOverride] = useState<SortDir | null>(
    () => (localStorage.getItem(SORT_DIR_KEY) as SortDir | null) || null,
  );
  const dir = dirOverride ?? DEFAULT_DIR[sort];
  useEffect(() => {
    if (dirOverride === null) localStorage.removeItem(SORT_DIR_KEY);
    else localStorage.setItem(SORT_DIR_KEY, dirOverride);
  }, [dirOverride]);
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
  // Shelf categories (历史 / 传记 / 侦探小说…): the tags users put on books.
  // Session-only on purpose — a filter left on overnight must never make the
  // shelf look like it lost books.
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // The shelf this page is actually showing, once the backend has answered.
  // `shelfLocked` is the reason the grid can be empty while the count says
  // otherwise: a locked shelf keeps its size visible and its books to itself.
  const currentShelf = shelves.find((s) => s.id === shelfId) ?? null;
  const shelfLocked = currentShelf?.locked === true;
  const selectionCount = selection?.size ?? 0;

  // The ref the async callbacks read: `load` is memoised for the lifetime of
  // the page, and it must ask for the shelf that is current when the answer
  // comes back, not the one that was current when it was created.
  const shelfIdRef = useRef(shelfId);
  shelfIdRef.current = shelfId;
  // The lock request for the shelf being left. Sent without waiting so a switch
  // stays instant, but awaited before the next switch: otherwise a fast round
  // trip can ask the backend about the shelf before it has been locked and be
  // told it is still open.
  const leaveLockRef = useRef<Promise<unknown>>(Promise.resolve());

  // tag -> book count, most used first (ties by name). Only tags that are
  // actually on books appear here; the chips row and the editor's reuse
  // suggestions are both built from it.
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of books) for (const t of b.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
  }, [books]);

  const sortedBooks = useMemo(() => {
    const base = activeTag ? books.filter((b) => (b.tags ?? []).includes(activeTag)) : books;
    if (sort === 'default') return base;
    const mul = dir === 'asc' ? 1 : -1;
    const arr = [...base];
    if (sort === 'title') arr.sort((a, b) => mul * a.title.localeCompare(b.title, 'zh'));
    else if (sort === 'author')
      arr.sort(
        (a, b) => mul * (a.author || '未知作者').localeCompare(b.author || '未知作者', 'zh'),
      );
    else
      arr.sort(
        (a, b) => mul * (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
      );
    return arr;
  }, [books, sort, dir, activeTag]);
  const visibleBooks = touch ? sortedBooks.slice(0, visibleCount) : sortedBooks;
  const totalRef = useRef(sortedBooks.length);
  totalRef.current = sortedBooks.length;
  // Whether the sentinel is currently mounted (cards remain). The observer
  // effect below must re-run when this flips: after the shelf was paged to the
  // end the sentinel is gone, and the very next sort/filter change re-renders
  // the full list in one commit — the effect runs while `sentinelRef.current`
  // is still null, bails, and the paging-reset effect then re-mounts the
  // sentinel WITHOUT re-running this effect. The observer would stay dead and
  // the shelf would be stuck on one page until an unrelated dep changed.
  const hasMore = visibleBooks.length < sortedBooks.length;

  // A fresh keyword or order restarts paging — otherwise the reader could be
  // parked on page 4 of a list that just changed underneath them.
  useEffect(() => {
    if (touch) setVisibleCount(PAGE_SIZE);
  }, [keyword, sort, dir, activeTag, touch]);

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
  }, [keyword, sort, dir, activeTag, books, loading, touch, hasMore]);

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
      // In selection mode a long-press is not a menu: the card is a checkbox,
      // and a menu on top of it would hide the very list being selected.
      onTouchStart: () => (selection ? undefined : startLongPress(b)),
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
    // In selection mode the card is a checkbox, not a door.
    if (selection) {
      toggleSelected(b.id);
      return;
    }
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
    const shelf = shelfIdRef.current;
    try {
      const next = await api.listBooks(kw, shelf);
      // The shelf can change while this request is on the wire (the reader
      // switched shelves from the sheet). The late answer belongs to the shelf
      // they just left, and painting it here would show another shelf's books.
      if (shelf !== shelfIdRef.current) return;
      // Coming back to the shelf re-fetches unconditionally, and the answer is
      // usually the identical list as fresh object identities. Replacing it then
      // repaints twelve cards and re-decodes twelve thumbnails for nothing —
      // measured as the tail of the "delay" after leaving a book. Keep the old
      // array when nothing actually changed.
      setBooks((prev) => (sameShelf(prev, next) ? prev : next));
      // Only the unfiltered shelf is worth remembering: a search result shown
      // on the next visit, before the keyword is even typed, would be wrong.
      if (!kw) cacheShelf({ shelfId: shelf, books: next });
    } catch (e) {
      toastError(e);
    } finally {
      if (shelf === shelfIdRef.current) setLoading(false);
    }
  }, []);

  // Every shelf, and a correction for a remembered id that no longer exists
  // (the shelf was deleted, or this is the first launch after the update).
  const loadShelves = useCallback(async () => {
    try {
      // A Go nil slice marshals to `null`, and an old host answers nothing at
      // all; either way there is at least the default shelf to fall back on.
      const list = (await api.listShelves()) ?? [];
      setShelves(list);
      if (list.length > 0 && !list.some((s) => s.id === shelfIdRef.current)) {
        const def = list.find((s) => s.id === DEFAULT_SHELF_ID) ?? list[0];
        shelfIdRef.current = def.id;
        setShelfId(def.id);
        rememberShelfId(def.id);
      }
      return list;
    } catch (e) {
      toastError(e);
      return [] as Shelf[];
    }
  }, []);

  useEffect(() => {
    void loadShelves();
    void load();
    // Books can also arrive while the user is elsewhere: a system-share
    // import (App.tsx) or a Wi-Fi transfer announces itself with this event.
    const onImported = () => {
      void loadShelves();
      void load();
    };
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
  }, [load, loadShelves]);

  // Switching shelves reloads. The first render is skipped: the effect above
  // has already asked for the shelf the page opened on.
  const shelfFirstRun = useRef(true);
  useEffect(() => {
    if (shelfFirstRun.current) {
      shelfFirstRun.current = false;
      return;
    }
    void load();
  }, [shelfId, load]);

  // How long the app may sit in the background before every shelf it opened is
  // put back behind its password. Five minutes is the "handed the phone to
  // someone while a call came in" window; the reader itself never runs this
  // (that would cut a chapter in half), so a book being listened to keeps
  // playing.
  const hiddenAt = useRef(0);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = 0;
      if (away < LOCK_AFTER_MS) {
        // Not long enough to lock, but long enough for the counts to have moved
        // (a Wi-Fi transfer, a system-share import).
        void loadShelves();
        return;
      }
      void (async () => {
        try {
          await api.lockAllShelves();
        } catch {
          /* an older backend: the shelves simply stay open */
        }
        await loadShelves();
        await load();
      })();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load, loadShelves]);

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
    // Importing into a locked shelf would either write into something the
    // reader cannot see, or silently land the book somewhere else.
    if (shelfLocked) {
      toast('这个书架已锁定，先解锁再导入', 'info');
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
      const res = await api.importPaths(epub, shelfIdRef.current);
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
      // The counts in the switcher changed with every added book.
      void loadShelves();
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

  // The host decides where the file goes: the share sheet on the phone, the
  // native save dialog on the desktop. See exportEpub.ts.
  async function exportBook(book: Book) {
    await exportBookToHost(book.id);
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

  /* ----------------------------- shelves ----------------------------- */

  // Switch the page to another shelf. The grid is replaced *before* the new
  // books arrive: for one paint the old list would otherwise be shown under the
  // new shelf's name, which for a locked shelf is the one thing that must never
  // happen. Searching, tag filtering and any selection belong to the shelf they
  // were made on, so they are dropped with it.
  function applyShelf(id: string) {
    if (id === shelfIdRef.current) return;
    // Leaving a shelf puts it back behind its password. Typing (or setting) the
    // password is proof for *this visit*, not a switch that stays on for the
    // rest of the process: the backend's "unlocked" mark outlives the page, so
    // without this the shelf looked like it had no password at all until the
    // app was killed and reopened.
    leaveLockRef.current = api.lockShelf(shelfIdRef.current).catch(() => undefined);
    shelfIdRef.current = id;
    setShelfId(id);
    rememberShelfId(id);
    const cached = cachedBooks(id);
    setBooks(cached ?? []);
    setLoading(cached === null);
    setVisibleCount(PAGE_SIZE);
    setActiveTag(null);
    setKeyword('');
    setSelection(null);
    setMoveOpen(false);
  }

  // The rows are drawn from the last ListShelves, which can be older than the
  // lock it describes: the app may have been in the background long enough to
  // re-lock, and the timer fires between two renders. So switching asks the
  // backend again instead of trusting the row — the cost is one local query,
  // and the alternative is opening a shelf that turns out to be empty because
  // it is locked.
  async function pickShelf(s: Shelf) {
    // Wait for the shelf being left to be locked first: a tap-away and a tap
    // back within a second must still find the password in place.
    await leaveLockRef.current;
    const fresh = (await loadShelves()).find((x) => x.id === s.id) ?? s;
    if (fresh.locked) {
      setUnlockTarget({ shelf: fresh, then: 'open' });
      return;
    }
    setShelfSheet(false);
    applyShelf(fresh.id);
  }

  async function afterUnlock() {
    const t = unlockTarget;
    if (!t) return;
    setUnlockTarget(null);
    await loadShelves();
    if (t.then === 'open') {
      setShelfSheet(false);
      if (t.shelf.id === shelfIdRef.current) {
        // Unlocking the shelf already on screen: nothing to switch, only to
        // load — the grid was empty a moment ago.
        setLoading(true);
        await load();
      } else {
        applyShelf(t.shelf.id);
      }
    } else {
      await doMove(t.shelf);
    }
  }

  /* ---- shelf management: create / rename / password / delete ---- */

  // Opening the form takes the sheet it came from off the screen first. Two
  // stacked sheets is not a cosmetic problem on a phone: both are anchored to
  // the same bottom edge, so whichever is painted second swallows the taps
  // meant for the other one — the input under the mask never gets focus, which
  // reads as "the keyboard does not open".
  function openShelfDialog(d: ShelfDialog) {
    setShelfMenu(null);
    setShelfSheet(false);
    setMoveOpen(false);
    setShelfForm({
      name: d.kind === 'create' ? '' : d.shelf.name,
      oldPw: '',
      newPw: '',
    });
    setShelfDialog(d);
  }

  // Cancel / mask / hardware back: put back whatever the form replaced.
  function closeShelfDialog(d: ShelfDialog | null) {
    setShelfDialog(null);
    if (!d) return;
    const back = d.kind === 'create' ? d.returnTo : 'shelf';
    if (back === 'move') {
      // The selection is the reason this sheet exists; if it is gone there is
      // nothing to move and reopening it would draw "移动 0 本到…".
      if (selection) setMoveOpen(true);
    } else {
      setShelfSheet(true);
    }
  }

  async function submitShelfDialog() {
    if (!shelfDialog || shelfBusy) return;
    setShelfBusy(true);
    try {
      if (shelfDialog.kind === 'create') {
        const created = await api.createShelf(shelfForm.name);
        toast(`已创建「${created.name}」`, 'success');
        const back = shelfDialog.returnTo;
        setShelfDialog(null);
        const list = await loadShelves();
        if (back === 'move') {
          // The new shelf is a destination for a batch that is already picked:
          // walking the page off to it would throw the selection away and leave
          // the books where they were. Stay put and offer it as a target.
          if (selection) setMoveOpen(true);
        } else {
          // Creating a shelf is a statement about where the next book goes: go
          // there, so 导入 lands in it rather than in the shelf being left.
          const target = list.find((s) => s.id === created.id) ?? created;
          applyShelf(target.id);
        }
      } else if (shelfDialog.kind === 'rename') {
        await api.renameShelf(shelfDialog.shelf.id, shelfForm.name);
        toast('已重命名', 'success');
        setShelfDialog(null);
        await loadShelves();
        setShelfSheet(true);
      } else {
        const clearing = shelfDialog.shelf.hasLock && !shelfForm.newPw;
        await api.setShelfLock(shelfDialog.shelf.id, shelfForm.oldPw, shelfForm.newPw);
        toast(clearing ? '已取消密码' : '密码已设置', 'success');
        setShelfDialog(null);
        // A shelf that just got its password back needs its lock state fresh.
        await loadShelves();
        setShelfSheet(true);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setShelfBusy(false);
    }
  }

  async function removeShelf(s: Shelf) {
    setShelfMenu(null);
    if (s.id === DEFAULT_SHELF_ID) return;
    if (
      !confirm(`删除书架「${s.name}」？\n\n里面的 ${s.bookCount} 本书会移到「书架」，不会被删除。`)
    ) {
      return;
    }
    try {
      const res = await api.deleteShelf(s.id);
      toast(`书架已删除，${res.moved} 本书移回「书架」`, 'success');
      const list = await loadShelves();
      if (s.id === shelfIdRef.current) {
        const def = list.find((x) => x.id === DEFAULT_SHELF_ID) ?? list[0];
        if (def) applyShelf(def.id);
      }
    } catch (e) {
      toastError(e);
    }
  }

  /* ---- selection and the batch move ---- */

  function startSelection(book?: Book) {
    setMenuBook(null);
    setMoveOpen(false);
    setSelection(new Set(book ? [book.id] : []));
  }

  function toggleSelected(id: string) {
    setSelection((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelection(new Set(sortedBooks.map((b) => b.id)));
  }

  async function chooseMoveTarget(s: Shelf) {
    // Same reason as pickShelf: moving into a shelf that just locked itself
    // would fail after the tap. Ask first.
    const fresh = (await loadShelves()).find((x) => x.id === s.id) ?? s;
    if (fresh.locked) {
      setMoveOpen(false);
      setUnlockTarget({ shelf: fresh, then: 'move' });
      return;
    }
    await doMove(fresh);
  }

  async function doMove(target: Shelf) {
    if (!selection || selection.size === 0) return;
    const ids = [...selection];
    try {
      setShelfBusy(true);
      const n = await api.moveBooks(ids, target.id);
      toast(`已移动 ${n} 本到「${target.name}」`, 'success');
      setSelection(null);
      setMoveOpen(false);
      await loadShelves();
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setShelfBusy(false);
    }
  }

  // Batch delete goes through the same soft delete as the per-book menu: the
  // books land in the trash and can come back, so a mis-tap on 全选 is
  // recoverable rather than a loss.
  async function deleteSelected() {
    if (!selection || selection.size === 0) return;
    const ids = [...selection];
    if (!confirm(`删除选中的 ${ids.length} 本书？\n\n它们会移到回收站，可随时恢复。`)) return;
    try {
      setShelfBusy(true);
      for (const id of ids) await api.deleteBook(id);
      toast(`已移入回收站 ${ids.length} 本`, 'success');
      setSelection(null);
      await loadShelves();
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setShelfBusy(false);
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

  // Reuse chip: append a tag that is already on some book, skipping ones the
  // input already carries. A comma is appended first when the field does not
  // end with one, so typing and tapping mix freely.
  function appendEditTag(t: string) {
    const have = parseTagInput(editForm.tags);
    if (have.includes(t)) return;
    const raw = editForm.tags.trimEnd();
    const next = !raw ? t : /[,，、;；]$/.test(raw) ? `${raw} ${t}` : `${raw}, ${t}`;
    setEditForm((f) => ({ ...f, tags: next }));
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
      className={`page library shell${over ? ' dropping' : ''}`}
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
        {/* The title is the shelf's name. Two taps to switch (name → list →
            shelf) is the right price when one of those taps may be a password:
            a chip row would still have to open a sheet for the lock, and it
            would put a second scrolling row 44px above the grid on a 360px
            phone, where the header already carries three icons. */}
        <h1 className="lib-title">
          <button
            className="shelf-pill"
            title={currentShelf?.name ?? '书架'}
            aria-label={`当前书架：${currentShelf?.name ?? '书架'}，点击切换`}
            // The rows are drawn from the last ListShelves, which can describe a
            // lock that has moved on: leaving a shelf locks it, so the first
            // look after a switch has to be refreshed or the row the password
            // is protecting still looks open.
            onClick={() => {
              setShelfSheet(true);
              void loadShelves();
            }}
          >
            <span className="shelf-pill-name">{currentShelf?.name ?? '书架'}</span>
            {shelfLocked && (
              <svg
                className="shelf-pill-lock"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <rect
                  x="2.2"
                  y="5.2"
                  width="7.6"
                  height="5.2"
                  rx="1.3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M4 5.2V3.9a2 2 0 0 1 4 0v1.3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
            <span className="shelf-pill-count">{currentShelf?.bookCount ?? books.length} 本</span>
            <svg
              className="shelf-pill-caret"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path
                d="M3 4.6 6 7.6 9 4.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </h1>
        <span style={{ flex: 1 }} />
        {/* Desktop only: the phone enters selection mode from the long-press
            sheet, because its header has no room for a fourth icon. */}
        {desktop && !selection ? (
          <button className="btn ghost desk-only" onClick={() => startSelection()}>
            选择
          </button>
        ) : null}
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
        {/* Importing is hidden while the shelf is locked: the book would land
            on the default shelf instead (a locked shelf cannot be written to),
            which reads as "the import vanished". */}
        {shelfLocked ? null : (
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
        )}
        <input
          className="input lib-search-input"
          placeholder="搜索书名或作者…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        {desktop && !shelfLocked ? (
          <button
            className="btn primary import-btn"
            disabled={importing}
            onClick={() => void pickAndImport()}
          >
            {importing ? '导入中…' : '导入 EPUB'}
          </button>
        ) : null}
      </div>

      {/* The action row: the tag filters, or — while selecting — the count and
          its two verbs. It is the same row in the same place, so entering
          selection mode does not move the grid down by a bar's height. */}
      {selection ? (
        <div className="lib-tags lib-selectbar" role="group" aria-label="批量操作">
          <span className="lib-select-count">已选 {selectionCount} 本</span>
          <button className="lib-tag-chip" onClick={selectAll}>
            全选
          </button>
          <button
            className="lib-tag-chip"
            onClick={() => {
              setSelection(null);
              // The move sheet belongs to a selection; leaving selection mode
              // must not leave it behind with "移动 0 本到…" on screen.
              setMoveOpen(false);
            }}
          >
            取消
          </button>
        </div>
      ) : (
        tagCounts.length > 0 && (
          <div className="lib-tags" role="group" aria-label="按标签筛选">
            <button
              className={`lib-tag-chip${activeTag === null ? ' on' : ''}`}
              onClick={() => setActiveTag(null)}
            >
              全部
            </button>
            {tagCounts.map(([t, n]) => (
              <button
                key={t}
                className={`lib-tag-chip${activeTag === t ? ' on' : ''}`}
                title={`${n} 本`}
                onClick={() => setActiveTag(activeTag === t ? null : t)}
              >
                {t}
              </button>
            ))}
          </div>
        )
      )}

      <div className="lib-scroll">
        {desktop && !shelfLocked ? (
          <div className={`dropzone${over ? ' over' : ''}`} onClick={() => void pickAndImport()}>
            {importing ? '正在解析 EPUB…' : '把 .epub 文件拖到这里，或点击选择文件（支持多选）'}
          </div>
        ) : null}
        {/* Phone: no hint bar. Drag-import cannot happen there and the ＋ in
            the header (and the FAB) already say where import lives. */}

        {shelfLocked ? (
          /* The shelf keeps its name and its size and nothing else. This is
             what the password buys: a phone handed around opens onto this. */
          <div className="shelf-locked">
            <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
              <rect
                x="5"
                y="10.4"
                width="14"
                height="9.6"
                rx="2.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M8.4 10.4V7.9a3.6 3.6 0 0 1 7.2 0v2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <p className="shelf-locked-title">「{currentShelf?.name}」已锁定</p>
            <p className="shelf-locked-sub">
              输入密码后可看到里面的 {currentShelf?.bookCount ?? 0} 本书
            </p>
            <button
              className="btn primary"
              onClick={() => currentShelf && setUnlockTarget({ shelf: currentShelf, then: 'open' })}
            >
              解锁
            </button>
          </div>
        ) : loading ? (
          <div className="loading">加载中…</div>
        ) : books.length === 0 ? (
          <div className="empty">
            <p style={{ fontSize: 15, marginBottom: 6 }}>这个书架还是空的</p>
            <p>
              {shelves.length > 1
                ? '导入 EPUB，或把别的书架上的书移动过来'
                : '导入第一本 EPUB 开始整理吧'}
            </p>
          </div>
        ) : (
          <div className="grid">
            {visibleBooks.map((b) => {
              const pct = progress[b.id];
              const pctLabel = pct > 0 ? `${Math.min(100, Math.round(pct * 100))}%` : null;
              return (
                <div
                  className={`book-card${pressedBook === b.id ? ' pressing' : ''}${
                    selection?.has(b.id) ? ' selected' : ''
                  }`}
                  key={b.id}
                  // The card is the open target, not just the cover: title,
                  // author, badge and the padding around them all open the book.
                  onClick={() => openBook(b)}
                  {...holdProps(b)}
                >
                  {/* Selection is a shape, not just a tint: on a phone the
                      covers are photographs and a colour wash all but vanishes
                      on a dark jacket. */}
                  {selection ? (
                    <span className="book-check" aria-hidden="true">
                      {selection.has(b.id) ? '✓' : ''}
                    </span>
                  ) : null}
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
                    {(b.tags?.length ?? 0) > 0 && (
                      <div className="book-tags">
                        {/* Two chips fit the card body; the rest collapse into
                            +n so a heavily tagged book cannot stretch it. The
                            active filter's tag lights up on its card. */}
                        {b.tags.slice(0, 2).map((t) => (
                          <span key={t} className={`book-tag${t === activeTag ? ' hit' : ''}`}>
                            {t}
                          </span>
                        ))}
                        {b.tags.length > 2 && (
                          <span className="book-tag more">+{b.tags.length - 2}</span>
                        )}
                      </div>
                    )}
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

      {/* Selection verbs. Fixed above the phone's tab bar (the CSS reserves
          that height), because it belongs to the grid underneath, not to the
          page's scrolling content. */}
      {selection && (
        <div className="lib-select-actions">
          <button
            className="btn primary"
            disabled={selectionCount === 0 || shelfBusy}
            onClick={() => setMoveOpen(true)}
          >
            移动到…
          </button>
          <button
            className="btn ghost danger"
            disabled={selectionCount === 0 || shelfBusy}
            onClick={() => void deleteSelected()}
          >
            删除
          </button>
        </div>
      )}

      {/* The switcher. One sheet for every shelf, with the ⋯ actions on each
          row: on a phone the sheet is the only place a password can be asked
          for, so switching and unlocking are the same conversation. */}
      {shelfSheet && (
        <div
          className="sheet-mask"
          onClick={() => {
            setUnlockTarget(null);
            setShelfSheet(false);
          }}
        >
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            {unlockTarget ? (
              <UnlockForm
                shelf={unlockTarget.shelf}
                onCancel={() => setUnlockTarget(null)}
                onDone={() => void afterUnlock()}
              />
            ) : (
              <>
                <div className="sheet-title">书架</div>
                <div className="shelf-list">
                  {shelves.map((s) => (
                    <div className={`shelf-row${s.id === shelfId ? ' on' : ''}`} key={s.id}>
                      <button
                        className="shelf-row-main"
                        aria-label={`切换到 ${s.name}`}
                        onClick={() => void pickShelf(s)}
                      >
                        <span className="shelf-row-mark">{s.id === shelfId ? '✓' : ''}</span>
                        <span className="shelf-row-name">{s.name}</span>
                        {s.locked && <span className="shelf-row-lock">🔒</span>}
                        <span className="shelf-row-count">{s.bookCount} 本</span>
                      </button>
                      <button
                        className="shelf-row-more"
                        aria-label={`管理 ${s.name}`}
                        onClick={() => setShelfMenu(s)}
                      >
                        ⋯
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="sheet-item"
                  onClick={() => openShelfDialog({ kind: 'create', returnTo: 'shelf' })}
                >
                  ＋ 新建书架
                </button>
                <button className="sheet-item cancel" onClick={() => setShelfSheet(false)}>
                  取消
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* One shelf's own actions. 删除 is offered on every shelf but the
          default one, and it says what happens to the books before it runs. */}
      {shelfMenu && (
        <div className="sheet-mask" onClick={() => setShelfMenu(null)}>
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{shelfMenu.name}</div>
            <button
              className="sheet-item"
              onClick={() => openShelfDialog({ kind: 'rename', shelf: shelfMenu })}
            >
              重命名
            </button>
            <button
              className="sheet-item"
              onClick={() => openShelfDialog({ kind: 'password', shelf: shelfMenu })}
            >
              {shelfMenu.hasLock ? '修改密码 / 取消密码' : '设置密码'}
            </button>
            {shelfMenu.id !== DEFAULT_SHELF_ID && (
              <button className="sheet-item danger" onClick={() => void removeShelf(shelfMenu)}>
                删除书架（书会移回「书架」）
              </button>
            )}
            <button className="sheet-item cancel" onClick={() => setShelfMenu(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Create / rename / password. One form, three intents, so the naming
          rules and the password rules are enforced in exactly one place. */}
      {shelfDialog && (
        <div
          className="sheet-mask"
          onClick={() => (shelfBusy ? undefined : closeShelfDialog(shelfDialog))}
        >
          <div className="sheet shelf-form" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">
              {shelfDialog.kind === 'create'
                ? '新建书架'
                : shelfDialog.kind === 'rename'
                  ? '重命名书架'
                  : shelfDialog.shelf.hasLock
                    ? '修改密码'
                    : '设置密码'}
            </div>
            {shelfDialog.kind === 'password' ? (
              <>
                {shelfDialog.shelf.hasLock && (
                  <label className="edit-field">
                    <span>当前密码</span>
                    <input
                      className="input"
                      type="password"
                      autoComplete="off"
                      value={shelfForm.oldPw}
                      onChange={(e) => setShelfForm((f) => ({ ...f, oldPw: e.target.value }))}
                    />
                  </label>
                )}
                <label className="edit-field">
                  <span>{shelfDialog.shelf.hasLock ? '新密码' : '密码（4–32 位）'}</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={shelfForm.newPw}
                    onChange={(e) => setShelfForm((f) => ({ ...f, newPw: e.target.value }))}
                  />
                </label>
                <p className="shelf-form-note">
                  {shelfDialog.shelf.hasLock
                    ? '留空并保存 = 取消密码。忘了密码无法找回，只能重置'
                    : '密码保护的是「拿在手里的这台手机」，不是磁盘上的文件。忘记后无法在应用内找回。'}
                </p>
              </>
            ) : (
              <label className="edit-field">
                <span>书架名</span>
                <input
                  className="input"
                  value={shelfForm.name}
                  maxLength={24}
                  placeholder="如：小说、专业书、待读"
                  onChange={(e) => setShelfForm((f) => ({ ...f, name: e.target.value }))}
                />
              </label>
            )}
            <div className="edit-actions">
              <button
                className="btn ghost"
                disabled={shelfBusy}
                onClick={() => closeShelfDialog(shelfDialog)}
              >
                取消
              </button>
              <button
                className="btn primary"
                disabled={shelfBusy}
                onClick={() => void submitShelfDialog()}
              >
                {shelfBusy ? '处理中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Where the selection goes. A locked destination asks for its password
          right here rather than after a detour, so a batch can be moved into a
          private shelf in one pass. */}
      {moveOpen && selection && (
        <div className="sheet-mask" onClick={() => setMoveOpen(false)}>
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">移动 {selectionCount} 本到…</div>
            {shelves.filter((s) => s.id !== shelfId).length === 0 ? (
              <p className="shelf-form-note">还没有别的书架，先新建一个。</p>
            ) : (
              shelves
                .filter((s) => s.id !== shelfId)
                .map((s) => (
                  <button
                    key={s.id}
                    className="sheet-item shelf-move-item"
                    onClick={() => void chooseMoveTarget(s)}
                  >
                    <span>{s.name}</span>
                    <span className="shelf-move-meta">
                      {s.locked ? '🔒 ' : ''}
                      {s.bookCount} 本
                    </span>
                  </button>
                ))
            )}
            <button
              className="sheet-item"
              onClick={() => openShelfDialog({ kind: 'create', returnTo: 'move' })}
            >
              ＋ 新建书架
            </button>
            <button className="sheet-item cancel" onClick={() => setMoveOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Unlocking outside the switcher: from the locked shelf's own screen, or
          for a move destination. The form is the same component, so there is
          one password field in the app and one place it can be wrong. */}
      {unlockTarget && !shelfSheet && (
        <div className="sheet-mask" onClick={() => setUnlockTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <UnlockForm
              shelf={unlockTarget.shelf}
              onCancel={() => setUnlockTarget(null)}
              onDone={() => void afterUnlock()}
            />
          </div>
        </div>
      )}

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
            <Link className="sheet-item" to="/opds" onClick={() => setImportOpen(false)}>
              从在线书库导入
            </Link>
            <button className="sheet-item cancel" onClick={() => setImportOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Shelf ordering. Persisted; the phone reaches it from the header
          sort icon. Picking a key resets to its natural direction; the
          方向 row flips 顺序/倒序 and stays open so the ✓ is visible. */}
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
                  setDirOverride(null);
                  // Reset paging in the same batch: without this the commit
                  // between the pick and the reset effect renders the whole
                  // sorted shelf once — 169 covers decoded for one frame.
                  setVisibleCount(PAGE_SIZE);
                  setSortOpen(false);
                }}
              >
                {sort === o.id ? '✓ ' : ''}
                {o.label}
              </button>
            ))}
            {sort !== 'default' && (
              <>
                <div className="sheet-dir-label">方向</div>
                {(
                  [
                    { id: 'asc', label: '顺序' },
                    { id: 'desc', label: '倒序' },
                  ] as Array<{ id: SortDir; label: string }>
                ).map((d) => (
                  <button
                    key={d.id}
                    className={`sheet-item${dir === d.id ? ' sort-on' : ''}`}
                    onClick={() => setDirOverride(d.id)}
                  >
                    {dir === d.id ? '✓ ' : ''}
                    {d.label}
                  </button>
                ))}
              </>
            )}
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
            {/* The way into multi-select on a phone. The header has no room for
                a fourth icon at 360px, and a long-press already means "what can
                I do with this one" — "and with its neighbours" is the same
                question. */}
            <button className="sheet-item" onClick={() => startSelection(menuBook)}>
              多选 / 批量移动
            </button>
            <button className="sheet-item" onClick={() => openEdit(menuBook)}>
              编辑（书名 / 作者 / 标签 / 封面）
            </button>
            <button
              className="sheet-item"
              onClick={() => {
                const bk = menuBook;
                setMenuBook(null);
                void exportBook(bk);
              }}
            >
              导出（生成 EPUB 分享）
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
              {/* Already-in-use labels, most used first: a tap appends instead
                  of typing, so the same word is never re-typed per book. */}
              {tagCounts.length > 0 && (
                <div className="edit-tags-used">
                  {tagCounts.map(([t]) => (
                    <button
                      key={t}
                      type="button"
                      className="lib-tag-chip"
                      onClick={() => appendEditTag(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
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

/**
 * The one password field in the app.
 *
 * Used from two places — the switcher (switching to a locked shelf) and the
 * move picker (moving a batch into one) — so the rules ("a wrong password is an
 * answer, not an error"; "the backoff has to be visible") are written once. It
 * never decides what happens next: `onDone` runs only after the backend said
 * the password was right.
 */
function UnlockForm({
  shelf,
  onCancel,
  onDone,
}: {
  shelf: Shelf;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The sheet's first frame is still hidden; focus() on a hidden element does
  // nothing at all, silently. Same rule as the reader's search box.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  async function submit() {
    if (busy) return;
    if (!pw) {
      setErr('请输入密码');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api.unlockShelf(shelf.id, pw);
      if (r.ok) {
        onDone();
        return;
      }
      setErr(
        r.retryAfterMs > 0
          ? `尝试次数过多，请等 ${Math.ceil(r.retryAfterMs / 1000)} 秒`
          : '密码不正确',
      );
      setPw('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unlock-form">
      <div className="sheet-title">解锁「{shelf.name}」</div>
      <label className="edit-field">
        <span>密码</span>
        <input
          ref={inputRef}
          className="input"
          type="password"
          autoComplete="off"
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setErr('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </label>
      {err && <p className="shelf-form-error">{err}</p>}
      <div className="edit-actions">
        <button className="btn ghost" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '解锁中…' : '解锁'}
        </button>
      </div>
    </div>
  );
}
