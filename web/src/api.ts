// The single binding layer between the UI and the Go backend. There is no HTTP
// layer and no port: every call is an in-process Wails binding, resolved by
// name through the host's runtime module (/wails/runtime.js).
//
// One bundle runs in both hosts — the desktop WebView2 and the Android
// WebView — and the transport is identical, so nothing here branches on the
// host except where a capability really differs (native dialogs vs SAF).
//
// Binary payloads (cover images, chapter render, exported EPUB) arrive inline
// as base64 data URLs / data strings, so the WebView never needs a separate
// asset server. Imports go through a native file dialog: the chosen
// filesystem path is read on the Go side, so no upload is required.

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

/**
 * One row of the lookup history: a word the reader tapped, when that first and
 * last happened, and the notebook's verdict on it. `inNotebook` false means the
 * page should offer to add it.
 */
export interface LookupHit {
  term: string;
  lookups: number;
  firstAt: string;
  lastAt: string;
  inNotebook: boolean;
  /** Empty when the word is not in the notebook yet. */
  status: '' | VocabEntry['status'];
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

/* ------------------------------- AI (0.4) ------------------------------- */

/** An endpoint the settings page offers in its dropdown. */
export interface AIPreset {
  name: string;
  baseUrl: string;
  model: string;
  /** e.g. "本地运行，密钥可留空" */
  note?: string;
}

/**
 * The AI settings as the settings page sees them. The key is never sent to
 * the frontend — only whether one is stored and its last four characters.
 */
export interface AIConfigView {
  baseUrl: string;
  model: string;
  keySet: boolean;
  /** Last four characters of the stored key, e.g. "…9f2a". */
  keyHint: string;
  /** Whether a call can be made at all (address + model filled in). */
  configured: boolean;
  presets: AIPreset[];
  /** The reader's standing prompt for hand-made chats; '' means the default. */
  chatSystem: string;
  /** The built-in default, for the placeholder and the 恢复默认 button. */
  chatSystemDefault: string;
}

/** One saved system prompt, offered to hand-made conversations. */
export interface AIPrompt {
  id: string;
  name: string;
  content: string;
  /** A seeded system prompt (对话 / 查词 / 拆句 / 导读): no delete, one-tap restore. */
  system: boolean;
  /** The built-in text of a system prompt, for the 恢复默认 affordance. */
  default?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The contextual gloss for one word: what it means in this sentence, plus the
 * sentence's own translation. `pos`/`note` are best-effort colour — either may
 * be empty.
 */
export interface ExplainResult {
  word: string;
  meaning: string;
  translation: string;
  pos: string;
  note: string;
  cached: boolean;
  /** The conversation this answer was filed under, for "continue in the AI page". */
  conversationId?: string;
}

/** One AI conversation: a lookup, a parse, a chapter guide, or a manual chat. */
export interface AIConversation {
  id: string;
  title: string;
  /** lookup | parse | summarize | manual */
  origin: string;
  createdAt: string;
  updatedAt: string;
}

/** A list row: header plus the facts the row shows. */
export interface AIConversationItem extends AIConversation {
  count: number;
  preview: string;
}

/**
 * One page of the list, newest activity first.
 *
 * The page is deliberately paged: a year of lookups is thousands of
 * transcripts, and the shelf of them is a scrolling list, not an export.
 * `total` labels the header without loading every row, and `hasMore` is what
 * the scroll sentinel asks for the next slice.
 */
export interface AIConversationPage {
  items: AIConversationItem[];
  total: number;
  hasMore: boolean;
}

/** One turn of a transcript. The system prompt is stored as a message too. */
export interface AIMessage {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AIConversationDetail extends AIConversation {
  messages: AIMessage[];
}

/** One continuation: what was asked and what came back, as stored. */
export interface AIChatTurn {
  conversationId: string;
  /** The opening prompt, present only when this send created the conversation. */
  system?: AIMessage;
  user: AIMessage;
  assistant: AIMessage;
}

/** One slice of a sentence with its grammatical role. */
export interface Segment {
  text: string;
  role: string;
  gloss: string;
}

/** The merged sentence view: translation and breakdown in one result. */
export interface ParseResult {
  translation: string;
  segments: Segment[];
  notes: string[];
  cached: boolean;
  /** The conversation this answer was filed under, for "查看对话". */
  conversationId?: string;
}

/** A word worth remembering from a chapter. */
export interface SummaryTerm {
  term: string;
  gloss: string;
}

/** The chapter guide. `truncated` says the chapter was cut to the prompt budget. */
export interface SummaryResult {
  summary: string;
  points: string[];
  terms: SummaryTerm[];
  truncated: boolean;
  cached: boolean;
  /** The conversation this guide was filed under, for "查看对话". */
  conversationId?: string;
}

/* ----------------------------- diagnostics (0.4) ----------------------------- */

/**
 * One line of the local diagnostic log. `data` is a flat map — the settings
 * page renders it as key/value rows without knowing any particular event.
 */
export interface LogEntry {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error' | string;
  cat: string;
  msg: string;
  data?: Record<string, string>;
}

/** The log's state: the switch, the file, and how much is buffered. */
export interface LogState {
  enabled: boolean;
  path: string;
  size: number;
  count: number;
  /** How large the file may get before the oldest part is dropped. */
  max: number;
  /** How much is dropped when it gets there. */
  trim: number;
}

/**
 * One round of filling in the notebook's missing glosses. `notFound` and
 * `failed` are different: the first means the dictionaries answered and neither
 * knew the word (it will not be asked again), the second means the request
 * itself did not get through (it stays queued).
 */
export interface GlossFillResult {
  tried: number;
  filled: number;
  notFound: number;
  failed: number;
  /** Words still unexplained after this round. */
  remaining: number;
}

/**
 * One screenful of an unbounded list.
 *
 * `total` counts the whole filtered set, not the downloaded part, so the header
 * can say how big the notebook is before any of it has arrived; `hasMore` is
 * the Go side's own verdict and saves the client from guessing at the edges.
 */
export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
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
  /**
   * Small JPEG of the cover (~20 KB, sized for a card). The shelf list ships
   * this instead of `coverUrl`: a full cover is ~400 KB, and forty of them in
   * one answer cost the phone about a second of frozen frames per visit.
   */
  thumbUrl: string | null;
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

export interface WifiShareStatus {
  running: boolean;
  port: number;
  url: string;
  ips?: string[];
  imports: number;
  duplicates: number;
  failures: string[];
  lastImportUnix?: number;
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

/** One configured OPDS catalog. `searchUrl` must keep the `{search}` slot. */
export interface OpdsSource {
  id?: string;
  name?: string;
  desc?: string;
  url: string;
  searchUrl?: string;
  username?: string;
  password?: string;
  /** 忽略 TLS 证书错误（自签证书用） */
  insecure?: boolean;
}

/** One <link> of a catalog entry, href already absolute. */
export interface OpdsLink {
  rel: string;
  href: string;
  type: string;
  title: string;
  length: number;
}

/**
 * One catalog row. Either a navigation node (`navHref` set — step into it) or a
 * publication (`downloads` non-empty — it can be imported).
 */
export interface OpdsEntry {
  id: string;
  title: string;
  author: string;
  summary: string;
  language: string;
  updated: string;
  thumbnail: string;
  navHref: string;
  downloads: OpdsLink[];
}

export interface OpdsFeed {
  title: string;
  /** URL this page was served from; the UI uses it as the "back" target. */
  requested: string;
  self: string;
  /** Absolute URL of the next page, empty on the last one. */
  next: string;
  prev: string;
  entries: OpdsEntry[];
}

/**
 * Imports the host's runtime module.
 *
 * There is no npm runtime dependency: every host serves its own at
 * /wails/runtime.js, with the prelude that picks the right transport for the
 * platform. Loading it also installs window._wails. @vite-ignore keeps vite
 * from trying to resolve the path at build time.
 *
 * A plain browser (vite dev, the acceptance harness) has no such module, so
 * the rejection is what "no backend" looks like — worth saying so instead of
 * surfacing a raw module-resolution error.
 */
let v3Runtime: Promise<any> | null = null;
function loadV3Runtime(): Promise<any> {
  if (!v3Runtime) {
    // A non-literal specifier keeps both vite (@vite-ignore) and tsc from
    // trying to resolve the path at build time; the host serves it at runtime.
    const specifier = '/wails/runtime.js';
    v3Runtime = import(/* @vite-ignore */ specifier).catch(() => {
      v3Runtime = null;
      throw new Error('后端未就绪：当前页面不在 EpubMaker 窗口里（浏览器预览没有 Go 后端）');
    });
  }
  return v3Runtime;
}

/**
 * Bound method names are fully qualified:
 * <go module path>.<package>.<type>.<method>. Both services are registered in
 * app/main.go and live in the same Go package, so the two names differ only in
 * the type name. Keep in sync if the module path or the service types change.
 */
const V3_BACKEND_FQN = 'epubmaker-desktop/internal/app.Backend';
const V3_APP_FQN = 'epubmaker-desktop/internal/app.App';

async function callFQN<T>(fqn: string, method: string, args: unknown[]): Promise<T> {
  const runtime = await loadV3Runtime();
  return (await runtime.Call.ByName(`${fqn}.${method}`, ...args)) as T;
}

/**
 * Backend object injected by the offline UI harness, if any.
 *
 * The acceptance scripts in D://tmp//epub-verify drive the built bundle in a
 * plain browser, where there is no host to call; they define window.go.app.*
 * before the page loads and assert on the resulting DOM. No real host ever
 * defines it — desktop and phone both go through /wails/runtime.js — so this is
 * a test seam, not a second transport to maintain.
 */
function injected(
  service: 'Backend' | 'App',
  method: string,
): ((...a: unknown[]) => unknown) | undefined {
  const fn = (window as any).go?.app?.[service]?.[method];
  return typeof fn === 'function' ? fn : undefined;
}

/** Calls a bound backend method (the data surface). */
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const fn = injected('Backend', method);
  if (fn) return (await fn(...args)) as T;
  return callFQN<T>(V3_BACKEND_FQN, method, args);
}

/** Calls a bound native-integration method (App: the file dialogs). */
async function callApp<T>(method: string, ...args: unknown[]): Promise<T> {
  const fn = injected('App', method);
  if (fn) return (await fn(...args)) as T;
  return callFQN<T>(V3_APP_FQN, method, args);
}

/**
 * Whether this is the desktop host rather than the Android one.
 *
 * Both run the same bundle, and the answer is needed on first render: the
 * shelf chooses its desktop or phone layout from it. The runtime's own
 * platform field only exists after an async import, so the user agent is the
 * one synchronous signal that separates a Windows WebView2 from an Android
 * WebView. The acceptance harness runs in Edge, which keeps it on the desktop
 * path — that is what its desktop cases assert.
 */
export function isDesktopHost(): boolean {
  if (typeof navigator === 'undefined') return true;
  return !/Android/i.test(navigator.userAgent);
}

/**
 * Subscribes to a host event. Returns a no-op unsubscribe when there is no
 * host, so callers never branch.
 *
 * The runtime hands the callback the whole {name, data} envelope rather than
 * the bare payload; unwrap `data` when present and pass anything else through.
 */
export async function onHostEvent(name: string, fn: (payload: any) => void): Promise<() => void> {
  let runtime: any;
  try {
    runtime = await loadV3Runtime();
  } catch {
    return () => {};
  }
  const off = runtime.Events?.On?.(name, (payload: any) => {
    const data =
      payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
    fn(data);
  });
  return typeof off === 'function' ? off : () => {};
}

/**
 * Subscribes to the Android system-share import events. When a book is shared
 * to EpubMaker from another app (WeChat, a browser, a file manager), the Java
 * host copies the content URI into the cache and emits "common:sharedImport"
 * with the copied file's path; this surfaces it to the frontend, which imports
 * it like any other path. Android only — a no-op unsubscribe on the desktop.
 */
export async function onSharedImport(fn: (path: string) => void): Promise<() => void> {
  if (isDesktopHost()) return () => {};
  return onHostEvent('common:sharedImport', (data: unknown) => {
    const path = typeof data === 'string' ? data : (data as { path?: string } | null)?.path;
    if (typeof path === 'string' && path) fn(path);
  });
}

/**
 * Opens the phone's file picker through the runtime's dialog module, which
 * routes to the SAF document picker and copies the picked documents into the
 * app cache — the Go side then reads plain paths, exactly like the desktop
 * flow.
 */
async function pickAndroid(multiple: boolean, title: string): Promise<string[]> {
  const runtime = await loadV3Runtime();
  const res = await runtime.Dialogs.OpenFile({
    CanChooseFiles: true,
    AllowsMultipleSelection: multiple,
    Title: title,
  });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

/**
 * EPUB multi-select that works on both hosts. [] = cancelled.
 *
 * The desktop goes through the App binding so the dialog keeps its .epub
 * filter; the phone has no such filters and needs SAF instead.
 */
export async function pickEpubFiles(): Promise<string[]> {
  if (isDesktopHost()) {
    const paths = await callApp<string[]>('SelectEpubFiles');
    return Array.isArray(paths) ? paths : [];
  }
  return pickAndroid(true, '选择 EPUB 文件');
}

/** Single image pick for the cover editor. null = cancelled. */
export async function pickImageFile(): Promise<string | null> {
  const path = isDesktopHost()
    ? await callApp<string>('SelectCoverFile')
    : (await pickAndroid(false, '选择封面图片'))[0];
  return path || null;
}

/** Single dictionary-file pick (ECDICT csv). null = cancelled. */
export async function pickDictFile(): Promise<string | null> {
  const path = isDesktopHost()
    ? await callApp<string>('SelectDictFile')
    : (await pickAndroid(false, '选择词库 CSV 文件'))[0];
  return path || null;
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Whether this host can hand a file to the Android share sheet: only the
 * Android runtime injects EpubMakerNative (the v3 runtime owns window.wails,
 * so the export surface got its own name). A desktop or a plain browser
 * preview has no such object and keeps the download flow.
 */
export function canShareEpubFile(): boolean {
  return typeof (window as any).EpubMakerNative?.shareExport === 'function';
}

/** Opens the system share sheet for a built EPUB file (Android only). */
export function shareEpubFile(path: string, filename: string): void {
  (window as any).EpubMakerNative.shareExport(path, filename);
}

export const api = {
  paths: () => call<AppPaths>('Paths'),

  /** Version string for the about page (Backend.AppVersion). */
  appVersion: () => call<string>('AppVersion'),

  /** Link timestamp for the about page; '' on dev builds (Backend.BuildTime). */
  buildTime: () => call<string>('BuildTime'),

  wifiShareStart: () => call<WifiShareStatus>('WifiShareStart'),
  wifiShareStop: () => call<WifiShareStatus>('WifiShareStop'),
  wifiShareStatus: () => call<WifiShareStatus>('WifiShareStatus'),

  listBooks: (keyword?: string) => call<Book[]>('ListBooks', keyword ?? ''),

  /** Opens the native EPUB multi-select dialog; returns [] when cancelled. */
  /** Imports EPUB files from local paths. Both the dialog and an OS file drop end
   * up here — a drop can only be turned into paths by the native side. Books
   * already on the shelf come back as `duplicates`, never as failures. */
  importPaths: (paths: string[]) =>
    call<{ books: Book[]; errors: string[]; duplicates?: string[] }>('ImportPaths', paths),

  getBook: (id: string) => call<Book>('GetBook', id),

  updateBook: (id: string, patch: Partial<Book> & { coverHref?: string | null }) =>
    call<Book>('UpdateBook', id, patch),

  deleteBook: (id: string) => call<{ deleted: boolean; movedToTrash: boolean }>('DeleteBook', id),

  trash: () => call<TrashItem[]>('ListTrash'),

  restoreTrash: (id: string) => call<Book>('RestoreBook', id),

  purgeTrash: (id: string) => call<{ purged: boolean; dataKept: boolean }>('PurgeBook', id),

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
    body: { title?: string; html?: string; afterChapterId?: string | null },
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
    note: string,
  ) =>
    call<Annotation>(
      'AddAnnotation',
      bookId,
      chapterId,
      startOffset,
      endOffset,
      pageIndex,
      text,
      color,
      note,
    ),

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
    deleteSource: boolean,
  ) => call<Book[]>('SplitBook', bookId, parts, deleteSource),

  /** Builds the EPUB and returns it inline as { filename, dataUrl }. */
  exportBook: (bookId: string) => call<{ filename: string; dataUrl: string }>('ExportBook', bookId),

  /** Builds the EPUB into the app's export staging dir and answers with the
   * absolute path plus its file name — the phone's share sheet needs a real
   * file, not a data URL. */
  exportBookFile: (bookId: string) =>
    call<{ path: string; filename: string }>('ExportBookFile', bookId),

  /* ---------------- WebDAV ---------------- */
  webdavTest: (conn: WebDavConn) => call<WebDavTestResult>('WebdavTest', conn),

  webdavList: (conn: WebDavConn, dirPath: string) =>
    call<WebDavEntry[]>('WebdavList', conn, dirPath),

  webdavImport: (conn: WebDavConn, items: { path: string; name: string }[]) =>
    call<{ books: Book[]; errors: string[] }>('WebdavImport', conn, items),

  /* ---------------- OPDS catalogs ---------------- */

  /** Catalogs shipped with the app (currently Project Gutenberg). */
  opdsSources: () => call<OpdsSource[]>('OpdsSources'),

  /**
   * Fetches one catalog page. `target` wins when set (following next/prev or a
   * navigation entry); otherwise `query` goes through the source's search
   * template, and an empty query means "the entry point".
   */
  opdsBrowse: (source: OpdsSource, query = '', target = '') =>
    call<OpdsFeed>('OpdsBrowse', source, query, target),

  /**
   * Downloads and imports the given entries. Each item carries the acquisition
   * links the feed published, and nothing else — the backend decides which file
   * to fetch (PickEpub), so the edition-picking rules live in exactly one place.
   * `duplicates` is not a failure: the book was already on the shelf.
   */
  opdsImport: (source: OpdsSource, items: { downloads?: OpdsLink[]; name: string }[]) =>
    call<{ books: Book[]; errors: string[]; duplicates?: string[] }>('OpdsImport', source, items),

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
  dictImport: (csvPath: string) =>
    call<{ entries: number; path: string }>('DictImportCSV', csvPath),

  /** One in-app downloadable dictionary offered by the Me page. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  dictSources: () =>
    call<Array<{ id: string; name: string; desc: string; url: string; bytes: number }>>(
      'DictSources',
    ),

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
    context: string,
  ) => call<VocabEntry>('VocabAdd', term, surface, bookId, chapterId, offset, context),

  /**
   * One screenful of the notebook, newest first. Both lists are unbounded —
   * every word that survives the frequency rule, every word ever tapped — so
   * neither is ever fetched whole: opening the page must not get slower the
   * longer the reader reads.
   */
  listVocab: (status: string, keyword: string, offset: number, limit: number) =>
    call<Page<VocabItem>>('ListVocab', status, keyword, offset, limit),

  /** The next review session: only words that have come due. */
  vocabQueue: (limit: number) => call<VocabItem[]>('VocabQueue', limit),

  vocabStats: () => call<VocabStats>('VocabStats'),

  /**
   * How many notebook words nothing can explain — not the local dictionary,
   * not a gloss fetched online before. Zero means the notebook reads normally
   * and the「联网补全」action stays hidden.
   */
  vocabGlossGaps: () => call<number>('VocabGlossGaps'),

  /**
   * Look up to `limit` unexplained words on a public dictionary and store what
   * comes back. This is the only call in the app that sends a word to a server,
   * and it only runs when the reader asks for it.
   */
  fillVocabGlosses: (limit: number) => call<GlossFillResult>('FillVocabGlosses', limit),

  setVocabStatus: (vid: string, status: string) => call<boolean>('SetVocabStatus', vid, status),

  /** Replace the example sentence kept with a word (the context is derived). */
  setVocabContext: (vid: string, context: string) => call<boolean>('SetVocabContext', vid, context),

  /** Record one review outcome and reschedule the word; returns the new state. */
  gradeVocab: (vid: string, known: boolean) => call<VocabEntry>('GradeVocab', vid, known),

  /** One screenful of every word ever looked up, newest first — the notebook's
   * raw material, and the longest list in the app. */
  listLookupHistory: (keyword: string, offset: number, limit: number) =>
    call<Page<LookupHit>>('ListLookupHistory', keyword, offset, limit),

  /* ---------------- AI (0.4): BYOK provider, three grounded abilities ---------------- */

  /** The AI settings with the key masked. Throws when the settings file is unreadable. */
  aiConfig: () => call<AIConfigView>('GetAIConfig'),

  /** Stores the settings. A blank key keeps the stored one (model-only change);
   *  a blank chatSystem restores the built-in default prompt. */
  saveAIConfig: (baseUrl: string, apiKey: string, model: string, chatSystem: string) =>
    call<boolean>('SaveAIConfig', baseUrl, apiKey, model, chatSystem),

  /** One tiny real call against the stored settings; reports, never throws. */
  aiTestConnection: () => call<{ ok: boolean; reply?: string; error?: string }>('AITestConnection'),

  /** Stores the standing prompt for hand-made chats. A blank text restores
   *  the built-in default. */
  aiSaveChatSystem: (chatSystem: string) => call<boolean>('AISaveChatSystem', chatSystem),

  /** Explains a word in the sentence it appeared in, and translates that sentence. */
  explainInContext: (word: string, sentence: string) =>
    call<ExplainResult>('ExplainInContext', word, sentence),

  /** Translation + breakdown of one sentence, in a single result. */
  parseSentence: (sentence: string) => call<ParseResult>('ParseSentence', sentence),

  /** A short guide for one chapter, from the chapter's own text. */
  summarizeChapter: (bookId: string, chapterId: string) =>
    call<SummaryResult>('SummarizeChapter', bookId, chapterId),

  /* ------------- AI conversations: the transcripts, and continuing them ------------- */

  /**
   * One page of conversations, newest activity first (30 unless told otherwise).
   *
   * `origin` narrows the list to one kind (lookup / parse / summarize / manual),
   * `keyword` searches titles and message bodies; both empty is the whole
   * library. The filter is the backend's job, not the page's: only thirty rows
   * are in hand at a time, so a client-side filter would search one page and
   * silently miss the rest.
   */
  aiConversations: (origin = '', keyword = '', offset = 0, limit = 30) =>
    call<AIConversationPage>('AIConversations', origin, keyword, offset, limit),

  /** One transcript in full — system prompt included. */
  aiConversation: (id: string) => call<AIConversationDetail | null>('AIConversation', id),

  aiConversationDelete: (id: string) => call<boolean>('AIConversationDelete', id),

  /**
   * Sends one message. An empty id starts a manual conversation and returns
   * the new one; otherwise the stored transcript (system prompt included)
   * goes back to the provider verbatim. A failed send rolls the user message
   * back, so a retry cannot duplicate it.
   */
  aiChatSend: (conversationId: string, text: string, promptId = '') =>
    call<AIChatTurn>('AIChatSend', conversationId, text, promptId),

  /* ------------------------- prompt library (0.4) ------------------------- */

  /** Every saved system prompt, most recently touched first. */
  aiPromptList: () => call<AIPrompt[]>('AIPromptList'),

  /** Creates (blank id) or updates one prompt; answers with the stored row. */
  aiPromptSave: (id: string, name: string, content: string) =>
    call<AIPrompt>('AIPromptSave', id, name, content),

  /** Deletes one prompt. Conversations already started keep their copy. */
  aiPromptDelete: (id: string) => call<boolean>('AIPromptDelete', id),

  /**
   * Puts a system prompt back to its built-in name and text. Only the seeded
   * prompts (对话 / 查词 / 拆句 / 导读) qualify; anything else is refused.
   */
  aiPromptReset: (id: string) => call<AIPrompt>('AIPromptReset', id),

  /**
   * The cached explanation for one word in one sentence, if the AI already
   * answered exactly this question. Never calls the provider; a miss is null.
   */
  aiExplainCached: (word: string, sentence: string) =>
    call<ExplainResult | null>('AIExplainCached', word, sentence),

  /* ---------------- 听书: the online neural voice ---------------- */

  /**
   * Synthesizes ONE sentence with Microsoft's neural voice and answers with the
   * mp3 as base64. Optional engine: the phone's own TTS (the EpubMakerTts
   * bridge) is the default, and this is what the reader picks when they want a
   * voice that does not sound like a machine.
   *
   * `rate` is a multiplier, the same unit the system engine takes.
   */
  ttsEdge: (text: string, voice: string, rate: number) =>
    call<string>('TtsEdge', text, voice, rate),

  /** The online voices the settings sheet offers (name + Chinese label). */
  edgeVoices: () => call<Array<{ name: string; label: string }>>('EdgeVoices'),

  /* ---------------- diagnostics: the local log ---------------- */

  /** Whether logging is on, where the file is, and how many entries are buffered. */
  logState: () => call<LogState>('GetLogState'),

  /** Newest entries, oldest first. `level` is a minimum ("warn" keeps errors). */
  logEntries: (limit: number, cat: string, level: string) =>
    call<LogEntry[]>('ListLogEntries', limit, cat, level),

  setLogEnabled: (enabled: boolean) => call<boolean>('SetLogEnabled', enabled),

  clearLog: () => call<boolean>('ClearLog'),

  /** Records something the WebView saw — a JS error, a route change. Never throws. */
  logClient: (level: string, cat: string, message: string, detail: string) =>
    call<boolean>('LogClient', level, cat, message, detail),
};
