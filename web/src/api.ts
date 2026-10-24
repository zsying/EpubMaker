// Wails v2 in-process bindings — there is no HTTP layer and no port.
//
// Every data call proxies to window.go.app.Backend.<Method>(...args), which
// returns a Promise. Binary responses (cover images, chapter render, exported
// EPUB) arrive inline as base64 data URLs / data strings, so the WebView never
// needs a separate asset server.
//
// Import and cover upload go through native OS file dialogs exposed on
// window.go.app.App (SelectEpubFiles / SelectCoverFile); the chosen filesystem
// path is read on the Go side, so no multipart upload is required.

/** One dictionary headword as the reader popover renders it. */
export interface WordDetail {
  word: string;
  phonetic: string;
  /** Chinese translation, newline separated ("\n" already unescaped server-side). */
  translation: string;
  /** English definition, newline separated. */
  definition: string;
  pos: string;
  tag: string;
  collins: number;
  frq: number;
  bnc: number;
}

/**
 * Result of looking a word up while reading.
 *
 * `entry` is the word as it was met — ECDICT ships inflected forms as their own
 * headwords, and those often define nothing but "past tense of X". `base` is
 * the lemma behind it, present only when it differs, so the popover can show
 * the real meaning instead of a cross-reference.
 */
export interface LookupResult {
  found: boolean;
  query: string;
  matched: string;
  lemmatized: boolean;
  entry?: WordDetail | null;
  base?: WordDetail | null;
  /** Top-5000 basic vocabulary: never auto-added to the notebook. */
  common: boolean;
  /** How many times this word has been looked up (0 for basic vocabulary). */
  seenCount: number;
  /** Whether this lookup put the word in the notebook. */
  recorded: boolean;
  vocabId: string;
}

/** A notebook entry. Words are global — they outlive the book they came from. */
export interface VocabEntry {
  id: string;
  term: string;
  surface: string;
  bookId: string;
  chapterId: string;
  /** Character offset inside the chapter, for jumping back to the sentence. */
  offset: number;
  context: string;
  status: 'new' | 'learning' | 'known' | 'ignored';
  lookups: number;
  /** How many times the word has been put in front of you in a review pass. */
  reviews: number;
  /** Empty until the first review. */
  lastReviewedAt: string;
  /**
   * Spaced-repetition state (SM-2). The interval is the current gap in days —
   * below 1 means the ten-minute relearning step — and `dueAt` is when the word
   * is next worth asking about (empty for a word that was never scheduled).
   */
  intervalDays: number;
  ease: number;
  dueAt: string;
  /** Consecutive clean passes; resets on a miss. */
  streak: number;
  /** Total misses. */
  lapses: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A notebook row as the notebook page renders it: the stored entry plus its
 * dictionary gloss and the titles of the place it was met. `bookTitle` is empty
 * when that book has since been deleted — the word stays, the trail does not.
 */
export interface VocabItem extends VocabEntry {
  bookTitle: string;
  chapterTitle: string;
  phonetic: string;
  translation: string;
}

export interface VocabStats {
  total: number;
  new: number;
  learning: number;
  known: number;
  ignored: number;
  /** Words whose schedule has come up — what the review button offers. */
  due: number;
}

export interface DictStatus {
  installed: boolean;
  path: string;
  entries: number;
}

/** A reading font stored in the app data dir (see /fonts/<file> serving). */
export interface FontInfo {
  file: string;
  size: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  language: string;
  publisher: string;
  description: string;
  identifier: string;
  coverHref: string | null;
  /** Inline base64 data URL (no HTTP). null when the book has no cover. */
  coverUrl: string | null;
  sourceName: string | null;
  chapterCount: number;
  /** User-managed tags; always an array (possibly empty). */
  tags: string[];
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shelf-level reading progress for one book (0..1). */
export interface BookProgress {
  bookId: string;
  percent: number;
  updatedAt: string;
}

export interface Chapter {
  id: string;
  bookId: string;
  index: number;
  title: string;
  href: string;
  updatedAt: string;
}

/** A node in the (possibly hierarchical) table of contents. */
export interface TocEntry {
  href: string;
  title: string;
  children?: TocEntry[];
}

export interface ImageAsset {
  href: string;
  size: number;
  /** Inline base64 data URL (no HTTP). */
  url: string;
}

export interface ReadingProgress {
  bookId: string;
  chapterId: string;
  pageIndex: number;
  pageCount: number;
  /** Layout-independent anchor: source character offset within the chapter. */
  positionOffset: number;
  updatedAt: string;
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: string;
  /** Page index within the chapter. */
  anchor: number;
  label: string;
  createdAt: string;
}

export interface Annotation {
  id: string;
  bookId: string;
  chapterId: string;
  startOffset: number;
  endOffset: number;
  text: string;
  /** Highlight color key, e.g. "yellow" | "green" | "red". */
  color: string;
  note: string;
  /** Page index within the chapter where the highlight was created. */
  pageIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkListItem extends Bookmark {
  bookTitle: string;
  chapterTitle: string;
}

export interface AnnotationListItem extends Annotation {
  bookTitle: string;
  chapterTitle: string;
}

export interface TrashItem {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  deletedAt: string | null;
  recoverable: boolean;
  dirName: string;
}

export interface AppPaths {
  appHome: string;
  configFile: string;
  dataDir: string;
  exportDir: string;
  logDir: string;
  dbFile: string;
}

export interface WebDavConn {
  baseUrl: string;
  username?: string;
  password?: string;
  /** 忽略 TLS 证书错误（自签证书用） */
  insecure?: boolean;
}

export interface WebDavEntry {
  name: string;
  /** 相对 baseUrl 的路径；目录以 / 结尾 */
  path: string;
  isDirectory: boolean;
  size: number;
  lastModified: string | null;
}

export interface WebDavTestResult {
  connected: boolean;
  server?: string;
  error?: string;
}

/**
 * True when the page is hosted by the Wails v3 runtime (the Android build).
 *
 * v2 injects generated bindings on window.go, so its presence means "not v3".
 * A v3 host serves its runtime at /wails/runtime.js, which the page must
 * import itself; window._wails only exists after that import, so before it we
 * fall back to recognizing the host by its origin. One bundle serves both
 * hosts, and the transport is chosen per call.
 */
function hasV3Runtime(): boolean {
  if (typeof window === 'undefined') return false;
  if ('_wails' in window) return true;
  if (typeof (window as any).go !== 'undefined') return false;
  return window.location.host === 'wails.localhost';
}

/**
 * Calls a v3 service method by name.
 *
 * The runtime is the host's own module at /wails/runtime.js, not the npm
 * package: it carries the prelude that selects the right transport for this
 * platform, and loading it also installs window._wails. @vite-ignore keeps
 * vite from trying to resolve the path at build time.
 */
let v3Runtime: Promise<any> | null = null;
function loadV3Runtime(): Promise<any> {
  if (!v3Runtime) {
    // A non-literal specifier keeps both vite (@vite-ignore) and tsc from
    // trying to resolve the path at build time; the host serves it at runtime.
    const specifier = '/wails/runtime.js';
    v3Runtime = import(/* @vite-ignore */ specifier).catch((err) => {
      v3Runtime = null;
      throw err;
    });
  }
  return v3Runtime;
}

/**
 * The v3 binding name is fully qualified: <go module path>.<package>.<type>.<method>.
 * Derived from the backend living in epubmaker-desktop/internal/app; see
 * app/cmd/mobile/main.go. Keep in sync when the module path changes.
 */
const V3_BACKEND_FQN = 'epubmaker-desktop/internal/app.Backend';

async function callV3<T>(method: string, args: unknown[]): Promise<T> {
  const runtime = await loadV3Runtime();
  return (await runtime.Call.ByName(`${V3_BACKEND_FQN}.${method}`, ...args)) as T;
}

/** Calls a bound backend method: window.go.app.Backend.<method>(...args). */
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const fn = (window as any).go?.app?.Backend?.[method];
  if (typeof fn === 'function') {
    return (await fn(...args)) as T;
  }
  if (hasV3Runtime()) {
    return await callV3<T>(method, args);
  }
  throw new Error('后端尚未就绪，请稍候重试');
}

/**
 * Whether this host can open a native file dialog, and therefore whether the
 * UI may offer file-based import at all.
 *
 * The desktop host drives the v2 runtime (window.go bindings plus the native
 * side's dialogs); the phone host drives v3, where only Backend is bound. A
 * plain browser (vite dev, the acceptance harness) has neither, so it keeps the
 * desktop shape and merely gets a clearer error.
 */
export function hasNativeDialogs(): boolean {
  return !hasV3Runtime();
}

/**
 * Opens the host's file picker and returns real filesystem paths.
 *
 * Desktop: the v2 App dialog (SelectEpubFiles). Phone (v3 host): the runtime's
 * dialog module, which on Android routes to the SAF document picker and copies
 * the picked documents into the app cache — the Go side then reads plain
 * paths, exactly like the desktop flow.
 */
async function pickV3(multiple: boolean, title: string): Promise<string[]> {
  const runtime = await loadV3Runtime();
  const res = await runtime.Dialogs.OpenFile({
    CanChooseFiles: true,
    AllowsMultipleSelection: multiple,
    Title: title,
  });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

/** EPUB multi-select that works on both hosts. [] = cancelled. */
export async function pickEpubFiles(): Promise<string[]> {
  if (!hasV3Runtime()) {
    const paths = await callApp<string[]>('SelectEpubFiles');
    return paths ?? [];
  }
  return pickV3(true, '选择 EPUB 文件');
}

/** Single image pick for the mobile cover editor. null = cancelled. */
export async function pickImageFile(): Promise<string | null> {
  if (!hasV3Runtime()) {
    const p = await callApp<string>('SelectCoverFile');
    return p || null;
  }
  const paths = await pickV3(false, '选择封面图片');
  return paths[0] ?? null;
}

/** Single dictionary-file pick (ECDICT csv). null = cancelled. */
export async function pickDictFile(): Promise<string | null> {
  if (!hasV3Runtime()) {
    const p = await callApp<string>('SelectDictFile');
    return p || null;
  }
  const paths = await pickV3(false, '选择词库 CSV 文件');
  return paths[0] ?? null;
}

/** Calls a bound App (native integration) method: window.go.app.App.<method>. */async function callApp<T>(method: string, ...args: unknown[]): Promise<T> {  const fn = (window as any).go?.app?.App?.[method];
  if (typeof fn === 'function') {
    return (await fn(...args)) as T;
  }
  // Native dialogs are desktop-only: App is built on the v2 runtime, so the
  // mobile host binds Backend alone. Say so instead of returning undefined.
  if (hasV3Runtime()) {
    throw new Error('此功能仅在桌面版提供');
  }
  throw new Error('无法打开系统文件选择框，请通过 Wails 启动应用');
}

/** Triggers a browser download from an inline data: URL. */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const api = {
  paths: () => call<AppPaths>('Paths'),

  /** Version string for the about page (Backend.AppVersion). */
  appVersion: () => call<string>('AppVersion'),

  listBooks: (keyword?: string) => call<Book[]>('ListBooks', keyword ?? ''),

  /** Opens the native EPUB multi-select dialog; returns [] when cancelled. */
  selectEpubFiles: () => callApp<string[]>('SelectEpubFiles'),

  /** Imports EPUB files from local paths. Both the dialog and an OS file drop end
   * up here — a drop can only be turned into paths by the native side. Books
   * already on the shelf come back as `duplicates`, never as failures. */
  importPaths: (paths: string[]) =>
    call<{ books: Book[]; errors: string[]; duplicates?: string[] }>('ImportPaths', paths),

  getBook: (id: string) => call<Book>('GetBook', id),

  updateBook: (id: string, patch: Partial<Book> & { coverHref?: string | null }) =>
    call<Book>('UpdateBook', id, patch),

  deleteBook: (id: string) =>
    call<{ deleted: boolean; movedToTrash: boolean }>('DeleteBook', id),

  trash: () => call<TrashItem[]>('ListTrash'),

  restoreTrash: (id: string) => call<Book>('RestoreBook', id),

  purgeTrash: (id: string) =>
    call<{ purged: boolean; dataKept: boolean }>('PurgeBook', id),

  listChapters: (bookId: string) => call<Chapter[]>('ListChapters', bookId),

  /** Hierarchical table of contents. Empty for books imported before hierarchy support. */
  bookTOC: (bookId: string) => call<TocEntry[]>('BookTOC', bookId),

  renderChapter: (bookId: string, cid: string) =>
    call<{ title: string; html: string }>('RenderChapter', bookId, cid),

  chapterSource: (bookId: string, cid: string) =>
    call<{ title: string; html: string }>('ChapterSource', bookId, cid),

  updateChapter: (bookId: string, cid: string, patch: { title?: string; html?: string }) =>
    call<Chapter>('UpdateChapter', bookId, cid, patch),

  createChapter: (
    bookId: string,
    body: { title?: string; html?: string; afterChapterId?: string | null }
  ) => call<Chapter>('CreateChapter', bookId, body),

  deleteChapter: (bookId: string, cid: string) =>
    call<{ deleted: boolean }>('DeleteChapter', bookId, cid),

  reorderChapters: (bookId: string, chapterIds: string[]) =>
    call<Chapter[]>('ReorderChapters', bookId, chapterIds),

  mergeChapters: (bookId: string, targetId: string, sourceIds: string[]) =>
    call<Chapter[]>('MergeChapters', bookId, targetId, sourceIds),

  images: (bookId: string) => call<ImageAsset[]>('ListImages', bookId),

  /* ---------------- reading: progress / bookmarks / annotations ---------------- */

  getProgress: (bookId: string) => call<ReadingProgress | null>('GetProgress', bookId),

  /** Shelf-level progress (0..1) for every book that has one. */
  listBookProgress: () => call<BookProgress[]>('ListProgress'),

  saveProgress: (bookId: string, chapterId: string, positionOffset: number, pageCount: number) =>
    call<ReadingProgress>('SaveProgress', bookId, chapterId, positionOffset, pageCount),

  listBookmarks: (bookId: string) => call<Bookmark[]>('ListBookmarks', bookId),

  addBookmark: (bookId: string, chapterId: string, anchor: number, label: string) =>
    call<Bookmark>('AddBookmark', bookId, chapterId, anchor, label),

  deleteBookmark: (id: string) => call<boolean>('DeleteBookmark', id),

  listAnnotations: (bookId: string) => call<Annotation[]>('ListAnnotations', bookId),

  addAnnotation: (
    bookId: string,
    chapterId: string,
    startOffset: number,
    endOffset: number,
    pageIndex: number,
    text: string,
    color: string,
    note: string
  ) => call<Annotation>('AddAnnotation', bookId, chapterId, startOffset, endOffset, pageIndex, text, color, note),

  updateAnnotation: (id: string, color: string, note: string) =>
    call<Annotation>('UpdateAnnotation', id, color, note),

  deleteAnnotation: (id: string) => call<boolean>('DeleteAnnotation', id),

  listAllBookmarks: () => call<BookmarkListItem[]>('ListAllBookmarks'),

  listAllAnnotations: () => call<AnnotationListItem[]>('ListAllAnnotations'),

  /** Opens the native image dialog, then uploads the chosen file as the cover. */
  uploadCover: (bookId: string) => {
    const path = callApp<string>('SelectCoverFile');
    return path.then((p) => {
      if (!p) throw new Error('未选择封面文件');
      return call<{ href: string; url: string; mediaType: string }>('UploadCoverPath', bookId, p);
    });
  },

  /** Uploads a cover from a path already on disk (mobile picker output). */
  uploadCoverFromPath: (bookId: string, path: string) =>
    call<{ href: string; url: string; mediaType: string }>('UploadCoverPath', bookId, path),

  split: (
    bookId: string,
    parts: { title: string; author?: string; chapterIds: string[]; coverHref?: string | null }[],
    deleteSource: boolean
  ) => call<Book[]>('SplitBook', bookId, parts, deleteSource),

  /** Builds the EPUB and returns it inline as { filename, dataUrl }. */
  exportBook: (bookId: string) =>
    call<{ filename: string; dataUrl: string }>('ExportBook', bookId),

  /* ---------------- WebDAV ---------------- */
  webdavTest: (conn: WebDavConn) => call<WebDavTestResult>('WebdavTest', conn),

  webdavList: (conn: WebDavConn, dirPath: string) =>
    call<WebDavEntry[]>('WebdavList', conn, dirPath),

  webdavImport: (conn: WebDavConn, items: { path: string; name: string }[]) =>
    call<{ books: Book[]; errors: string[] }>('WebdavImport', conn, items),

  /* ---------------- reading: dictionary / vocabulary ---------------- */

  dictStatus: () => call<DictStatus>('DictStatus'),

  /* ---------------- reading fonts ---------------- */

  /** Downloaded fonts stored under <dataDir>/fonts (served at /fonts/<file>). */
  listFonts: () => call<FontInfo[]>('ListFonts'),

  /** Downloads a font file into the data dir. Blocking; call again on failure. */
  downloadFont: (file: string, url: string) => call<FontInfo>('DownloadFont', file, url),

  deleteFont: (file: string) => call<boolean>('DeleteFont', file),

  /** Opens the native csv picker; returns '' when the user cancels. */
  selectDictFile: () => callApp<string>('SelectDictFile'),

  /** Builds the local dictionary from an ECDICT csv chosen on disk. Blocking. */
  dictImport: (csvPath: string) => call<{ entries: number; path: string }>('DictImportCSV', csvPath),

  /** One in-app downloadable dictionary offered by the Me page. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  dictSources: () => call<Array<{ id: string; name: string; desc: string; url: string; bytes: number }>>('DictSources'),

  /** Downloads a catalog source and imports it. Blocking; minutes on a phone. */
  downloadDict: (id: string) => call<{ entries: number; source: string }>('DownloadDict', id),

  lookupWord: (bookId: string, chapterId: string, offset: number, word: string, context: string) =>
    call<LookupResult>('LookupWord', bookId, chapterId, offset, word, context),

  vocabAdd: (
    term: string,
    surface: string,
    bookId: string,
    chapterId: string,
    offset: number,
    context: string
  ) => call<VocabEntry>('VocabAdd', term, surface, bookId, chapterId, offset, context),

  listVocab: (status: string, keyword: string) => call<VocabItem[]>('ListVocab', status, keyword),

  /** The next review session: only words that have come due. */
  vocabQueue: (limit: number) => call<VocabItem[]>('VocabQueue', limit),

  vocabStats: () => call<VocabStats>('VocabStats'),

  setVocabStatus: (vid: string, status: string) => call<boolean>('SetVocabStatus', vid, status),

  /** Record one review outcome and reschedule the word; returns the new state. */
  gradeVocab: (vid: string, known: boolean) => call<VocabEntry>('GradeVocab', vid, known),

  deleteVocab: (vid: string) => call<boolean>('DeleteVocab', vid)
};
