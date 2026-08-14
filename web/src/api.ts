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
  deletedAt: string | null;
  createdAt: string;
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

/** Calls a bound backend method: window.go.app.Backend.<method>(...args). */
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const fn = (window as any).go?.app?.Backend?.[method];
  if (typeof fn !== 'function') {
    throw new Error('后端尚未就绪，请稍候重试');
  }
  return (await fn(...args)) as T;
}

/** Calls a bound App (native integration) method: window.go.app.App.<method>. */
async function callApp<T>(method: string, ...args: unknown[]): Promise<T> {
  const fn = (window as any).go?.app?.App?.[method];
  if (typeof fn !== 'function') {
    throw new Error('无法打开系统文件选择框，请通过 Wails 启动应用');
  }
  return (await fn(...args)) as T;
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

  listBooks: (keyword?: string) => call<Book[]>('ListBooks', keyword ?? ''),

  /** Opens the native EPUB multi-select dialog, then imports the chosen files. */
  importBooks: async (): Promise<{ books: Book[]; errors: string[] }> => {
    const paths = await callApp<string[]>('SelectEpubFiles');
    if (!paths || paths.length === 0) return { books: [], errors: [] };
    return call('ImportPaths', paths);
  },

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
    call<{ books: Book[]; errors: string[] }>('WebdavImport', conn, items)
};
