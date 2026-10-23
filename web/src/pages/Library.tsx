import { DragEvent as ReactDragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, AppPaths, Book, DictStatus, downloadDataUrl } from '../api';
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
  paths: AppPaths | null;
  dict: DictStatus | null;
};
let shelfCache: ShelfCache | null = null;

function cacheShelf(patch: Partial<ShelfCache>) {
  shelfCache = { books: [], paths: null, dict: null, ...shelfCache, ...patch };
}

export default function Library() {
  const [books, setBooks] = useState<Book[]>(() => shelfCache?.books ?? []);
  const [keyword, setKeyword] = useState('');
  // Only a shelf with nothing to show is "loading"; a refresh must never blank
  // what is already on screen.
  const [loading, setLoading] = useState(shelfCache === null);
  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState(false);
  const [paths, setPaths] = useState<AppPaths | null>(() => shelfCache?.paths ?? null);
  // Local ECDICT dictionary: imported from a csv chosen on disk. Without it the
  // reader's lookup is disabled, so its state is surfaced here.
  const [dict, setDict] = useState<DictStatus | null>(() => shelfCache?.dict ?? null);
  const [dictBusy, setDictBusy] = useState(false);
  const nav = useNavigate();

  const load = useCallback(async (kw?: string) => {
    try {
      const next = await api.listBooks(kw);
      setBooks(next);
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
    api
      .paths()
      .then((p) => {
        setPaths(p);
        cacheShelf({ paths: p });
      })
      .catch(() => undefined);
    api
      .dictStatus()
      .then((d) => {
        setDict(d);
        cacheShelf({ dict: d });
      })
      .catch(() => undefined);
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

  // Opens the native EPUB picker and imports the chosen files via bindings.
  async function pickAndImport() {
    try {
      const paths = await api.selectEpubFiles();
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
      toast(`成功导入 ${res.books.length} 本书籍`, 'success');
      if (ignored > 0) toast(`已跳过 ${ignored} 个非 EPUB 文件`, 'info');
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
  const isFileDrag = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

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
    if (dict?.installed && !confirm(`已安装词库（${dict.entries} 条）。重新导入会覆盖现有词库，继续？`)) {
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
      <div className="lib-head">
        <h1>书架</h1>
        <span className="tag">{books.length} 本</span>
        <span style={{ flex: 1 }} />
        <Link className="btn ghost" to="/trash">
          回收站
        </Link>
        <button
          className="btn ghost"
          disabled={dictBusy}
          title={dict?.installed ? `词库路径：${dict.path}` : '尚未安装词库，查词功能不可用'}
          onClick={() => void doImportDict()}
        >
          {dictBusy ? '导入词库…' : dict?.installed ? `词库 ${dict.entries} 条` : '导入词库'}
        </button>
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="搜索书名或作者…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button className="btn primary" disabled={importing} onClick={() => void pickAndImport()}>
          {importing ? '导入中…' : '导入 EPUB'}
        </button>
      </div>

      <div className="lib-scroll">
        <div className={`dropzone${over ? ' over' : ''}`} onClick={() => void pickAndImport()}>
          {importing ? '正在解析 EPUB…' : '把 .epub 文件拖到这里，或点击选择文件（支持多选）'}
        </div>

        {loading ? (
          <div className="loading">加载中…</div>
        ) : books.length === 0 ? (
          <div className="empty">
            <p style={{ fontSize: 15, marginBottom: 6 }}>书架还是空的</p>
            <p>导入第一本 EPUB 开始整理吧</p>
          </div>
        ) : (
          <div className="grid">
            {books.map((b) => (
              <div className="book-card" key={b.id}>
                <div className="cover" onClick={() => nav(`/books/${b.id}/read`)} style={{ cursor: 'pointer' }}>
                  {b.coverUrl ? (
                    <img src={b.coverUrl} alt={b.title} loading="lazy" />
                  ) : (
                    <div className="placeholder">{b.title}</div>
                  )}
                </div>
                <div className="book-body">
                  <div className="book-title" title={b.title}>
                    {b.title}
                  </div>
                  <div className="book-meta">{b.author || '未知作者'}</div>
                  <div className="book-meta">{b.chapterCount} 章</div>
                </div>
                <div className="book-actions">
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
            ))}
          </div>
        )}

        {paths && (
          <div style={{ marginTop: 40, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.9 }}>
            <div>
              <strong style={{ color: 'var(--text-2)' }}>存储位置</strong>（可在 config.json 中修改）
            </div>
            <div>配置文件：{paths.configFile}</div>
            <div>数据目录：{paths.dataDir}</div>
            <div>导出目录：{paths.exportDir}</div>
            <div>日志目录：{paths.logDir}</div>
          </div>
        )}
      </div>
    </div>
  );
}
