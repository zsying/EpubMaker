export interface Book {
  id: string;
  title: string;
  author: string;
  language: string;
  publisher: string;
  description: string;
  identifier: string;
  coverHref: string | null;
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

export interface ImageAsset {
  href: string;
  size: number;
  url: string;
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

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let payload: { ok?: boolean; data?: T; error?: string };
  try {
    payload = await res.json();
  } catch {
    throw new Error(`请求失败 (${res.status})`);
  }
  if (!res.ok || payload.ok === false) throw new Error(payload.error || `请求失败 (${res.status})`);
  return payload.data as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

export const api = {
  paths: () => req<AppPaths>('/api/config'),

  listBooks: (keyword?: string) =>
    req<Book[]>(`/api/books${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),

  importBooks: async (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    return req<{ books: Book[]; errors: string[] }>('/api/books/import', { method: 'POST', body: fd });
  },

  getBook: (id: string) => req<Book>(`/api/books/${id}`),

  updateBook: (id: string, patch: Partial<Book> & { coverHref?: string | null }) =>
    req<Book>(`/api/books/${id}`, { ...json(patch), method: 'PATCH' }),

  deleteBook: (id: string) =>
    req<{ deleted: boolean; movedToTrash: boolean }>(`/api/books/${id}`, { method: 'DELETE' }),

  trash: () => req<TrashItem[]>('/api/trash'),

  restoreTrash: (id: string) => req<Book>(`/api/trash/${id}/restore`, { method: 'POST' }),

  purgeTrash: (id: string) =>
    req<{ purged: boolean; dataKept: boolean }>(`/api/trash/${id}`, { method: 'DELETE' }),

  listChapters: (bookId: string) => req<Chapter[]>(`/api/books/${bookId}/chapters`),

  renderChapter: (bookId: string, cid: string) =>
    req<{ title: string; html: string }>(`/api/books/${bookId}/chapters/${cid}/render`),

  chapterSource: (bookId: string, cid: string) =>
    req<{ title: string; html: string }>(`/api/books/${bookId}/chapters/${cid}/source`),

  updateChapter: (bookId: string, cid: string, patch: { title?: string; html?: string }) =>
    req<Chapter>(`/api/books/${bookId}/chapters/${cid}`, { ...json(patch), method: 'PATCH' }),

  createChapter: (bookId: string, body: { title?: string; html?: string; afterChapterId?: string | null }) =>
    req<Chapter>(`/api/books/${bookId}/chapters`, json(body)),

  deleteChapter: (bookId: string, cid: string) =>
    req<{ deleted: boolean }>(`/api/books/${bookId}/chapters/${cid}`, { method: 'DELETE' }),

  reorderChapters: (bookId: string, chapterIds: string[]) =>
    req<Chapter[]>(`/api/books/${bookId}/chapters/reorder`, json({ chapterIds })),

  mergeChapters: (bookId: string, targetId: string, sourceIds: string[]) =>
    req<Chapter[]>(`/api/books/${bookId}/chapters/merge`, json({ targetId, sourceIds })),

  images: (bookId: string) => req<ImageAsset[]>(`/api/books/${bookId}/images`),

  uploadCover: (bookId: string, file: File) => {
    const fd = new FormData();
    fd.append('cover', file);
    return req<{ href: string; url: string; mediaType: string }>(`/api/books/${bookId}/covers`, {
      method: 'POST',
      body: fd
    });
  },

  split: (
    bookId: string,
    parts: { title: string; author?: string; chapterIds: string[]; coverHref?: string | null }[],
    deleteSource: boolean
  ) => req<Book[]>(`/api/books/${bookId}/split`, json({ parts, deleteSource })),

  exportUrl: (bookId: string) => `/api/books/${bookId}/export`,

  /* ---------------- WebDAV ---------------- */
  webdavTest: (conn: WebDavConn) =>
    req<WebDavTestResult>('/api/webdav/test', json(conn)),

  webdavList: (conn: WebDavConn, dirPath: string) =>
    req<WebDavEntry[]>('/api/webdav/list', json({ ...conn, path: dirPath })),

  webdavImport: (conn: WebDavConn, items: { path: string; name: string }[]) =>
    req<{ books: Book[]; errors: string[] }>('/api/webdav/import', json({ ...conn, items }))
};
