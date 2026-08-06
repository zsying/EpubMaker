import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { db, nowIso, tx, uid } from '../db';
import { logger } from '../logger';
import { buildEpub, BuildAsset, BuildChapter } from '../epub/build';
import {
  collectCssReferences,
  collectReferences,
  encodeHrefForUrl,
  extractBody,
  extractTitle,
  normalizeHref,
  replaceBody,
  rewriteResourceUrls,
  stripTags,
  wrapDocument
} from '../epub/html';
import { guessMediaType } from '../epub/mime';
import { parseEpub, readEntry } from '../epub/parse';
import { AssetRow, BookDTO, BookRow, ChapterDTO, ChapterRow } from '../types';
import {
  bookDir,
  contentExists,
  contentPath,
  contentSize,
  findTrashDir,
  moveBookDirToTrash,
  readContent,
  readContentText,
  removeBookDir,
  sanitizeFileName,
  trashRoot,
  writeContent
} from './storage';

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export function toBookDTO(row: BookRow, chapterCount: number): BookDTO {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    language: row.language,
    publisher: row.publisher,
    description: row.description,
    identifier: row.identifier,
    coverHref: row.cover_href,
    coverUrl: row.cover_href ? `/api/books/${row.id}/assets/${encodeHrefForUrl(row.cover_href)}` : null,
    sourceName: row.source_name,
    chapterCount,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listBooks(keyword?: string): BookDTO[] {
  const d = db();
  const rows = keyword
    ? d
        .prepare(
          `SELECT * FROM books WHERE deleted_at IS NULL AND (title LIKE ? OR author LIKE ?) ORDER BY updated_at DESC`
        )
        .all<BookRow>(`%${keyword}%`, `%${keyword}%`)
    : d
        .prepare(`SELECT * FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC`)
        .all<BookRow>();
  const counts = d
    .prepare(`SELECT book_id, COUNT(*) AS n FROM chapters GROUP BY book_id`)
    .all<{ book_id: string; n: number }>();
  const map = new Map(counts.map((c) => [c.book_id, Number(c.n)]));
  return rows.map((r) => toBookDTO(r, map.get(r.id) ?? 0));
}

export function getBookRow(id: string): BookRow | undefined {
  return db().prepare(`SELECT * FROM books WHERE id = ?`).get<BookRow>(id);
}

export function getBook(id: string): BookDTO | null {
  const row = getBookRow(id);
  if (!row || row.deleted_at) return null;
  const c = db().prepare(`SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?`).get<{ n: number }>(id);
  return toBookDTO(row, Number(c?.n ?? 0));
}

export function listChapters(bookId: string): ChapterDTO[] {
  return db()
    .prepare(`SELECT * FROM chapters WHERE book_id = ? ORDER BY idx ASC`)
    .all<ChapterRow>(bookId)
    .map((r) => ({
      id: r.id,
      bookId: r.book_id,
      index: r.idx,
      title: r.title,
      href: r.href,
      updatedAt: r.updated_at
    }));
}

export function getChapterRow(bookId: string, chapterId: string): ChapterRow | undefined {
  return db()
    .prepare(`SELECT * FROM chapters WHERE book_id = ? AND id = ?`)
    .get<ChapterRow>(bookId, chapterId);
}

export function listAssets(bookId: string): AssetRow[] {
  return db().prepare(`SELECT * FROM assets WHERE book_id = ? ORDER BY href`).all<AssetRow>(bookId);
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

export async function importEpub(filePath: string, originalName: string): Promise<BookDTO> {
  const data = await fs.promises.readFile(filePath);
  const parsed = await parseEpub(data);
  const bookId = uid();
  const ts = nowIso();

  // 逐条写出资源：每次只解压一个条目并落盘，避免大图片同时驻留内存
  const sizes = new Map<string, number>();
  for (const [href, entry] of parsed.entries) {
    const buf = await readEntry(entry);
    writeContent(bookId, href, buf);
    sizes.set(href, buf.length);
  }
  // 解析完成，释放 zip 持有的压缩数据
  parsed.entries.clear();

  if (config().keepOriginalEpub) {
    const dest = path.join(config().paths.books, bookId, 'original.epub');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);
  }

  const title =
    parsed.metadata.title && parsed.metadata.title !== '未命名书籍'
      ? parsed.metadata.title
      : path.basename(originalName, path.extname(originalName));

  // 预先解析章节标题（需要读取正文，放在事务外避免异步读写混进同步事务）
  const chapterTitles = await Promise.all(
    parsed.spine.map(async (item, i) => {
      let chTitle = parsed.toc[item.href] ?? '';
      if (!chTitle) {
        const entry = parsed.entries.get(item.href);
        if (entry) chTitle = extractTitle((await readEntry(entry)).toString('utf8'));
      }
      if (!chTitle) chTitle = `第 ${i + 1} 节`;
      return chTitle;
    })
  );

  tx(() => {
    const d = db();
    d.prepare(
      `INSERT INTO books (id,title,author,language,publisher,description,identifier,cover_href,source_name,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      bookId,
      title,
      parsed.metadata.author,
      parsed.metadata.language,
      parsed.metadata.publisher,
      parsed.metadata.description,
      parsed.metadata.identifier,
      parsed.coverHref,
      originalName,
      ts,
      ts
    );

    const insertChapter = d.prepare(
      `INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
    );
    parsed.spine.forEach((item, i) => {
      insertChapter.run(uid(), bookId, i, chapterTitles[i], item.href, ts, ts);
    });

    const insertAsset = d.prepare(
      `INSERT INTO assets (id,book_id,href,media_type,size) VALUES (?,?,?,?,?)`
    );
    for (const res of parsed.resources) {
      const size = sizes.get(res.href);
      if (size === undefined) continue;
      insertAsset.run(uid(), bookId, res.href, res.mediaType || guessMediaType(res.href), size);
    }
  });

  logger.info(`导入书籍成功: ${title} (${bookId})，章节 ${parsed.spine.length} 个，资源 ${parsed.resources.length} 个`);
  return getBook(bookId)!;
}

/* ------------------------------------------------------------------ */
/* 书籍整理                                                            */
/* ------------------------------------------------------------------ */

export interface BookPatch {
  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  description?: string;
  identifier?: string;
  coverHref?: string | null;
}

export function updateBook(id: string, patch: BookPatch): BookDTO | null {
  const row = getBookRow(id);
  if (!row) return null;
  const next: BookRow = {
    ...row,
    title: patch.title ?? row.title,
    author: patch.author ?? row.author,
    language: patch.language ?? row.language,
    publisher: patch.publisher ?? row.publisher,
    description: patch.description ?? row.description,
    identifier: patch.identifier ?? row.identifier,
    cover_href: patch.coverHref === undefined ? row.cover_href : patch.coverHref,
    updated_at: nowIso()
  };
  db()
    .prepare(
      `UPDATE books SET title=?,author=?,language=?,publisher=?,description=?,identifier=?,cover_href=?,updated_at=? WHERE id=?`
    )
    .run(
      next.title,
      next.author,
      next.language,
      next.publisher,
      next.description,
      next.identifier,
      next.cover_href,
      next.updated_at,
      id
    );
  return getBook(id);
}

/** 软删除：把书目录移入回收站并标记 deleted_at，可恢复 */
export function deleteBook(id: string): { deleted: boolean; movedToTrash: boolean } {
  const row = getBookRow(id);
  if (!row) return { deleted: false, movedToTrash: false };
  if (row.deleted_at) return { deleted: true, movedToTrash: true };
  // 目录整体改名移入回收站（rename 不触发批量删除拦截，数据可恢复）
  const moved = moveBookDirToTrash(id);
  tx(() => {
    const ts = nowIso();
    db()
      .prepare(`UPDATE books SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .run(ts, ts, id);
  });
  logger.info(`删除书籍(移入回收站): ${row.title} (${id})`);
  return { deleted: true, movedToTrash: moved };
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

export interface TrashItem {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  deletedAt: string | null;
  /** 是否有数据库记录可恢复（纯孤儿目录不可恢复，只能彻底删除） */
  recoverable: boolean;
  dirName: string;
}

/** 列出回收站条目（扫描 trash 目录 + 关联数据库记录） */
export function listTrash(): TrashItem[] {
  const root = trashRoot();
  if (!fs.existsSync(root)) return [];
  const items: TrashItem[] = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || name === '_purged') continue;
    const m = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    const id = m ? m[1] : name;
    const row = getBookRow(id);
    if (row) {
      // 有数据库记录：显示书名；仅 deleted_at 非空（软删除）才可恢复
      items.push({
        id,
        title: row.title || '（未命名书籍）',
        author: row.author,
        coverUrl: null,
        deletedAt: row.deleted_at ?? null,
        recoverable: !!row.deleted_at,
        dirName: name
      });
    } else {
      items.push({
        id,
        title: '（原记录已删除）',
        author: '',
        coverUrl: null,
        deletedAt: null,
        recoverable: false,
        dirName: name
      });
    }
  }
  items.sort((a, b) => (b.deletedAt || b.dirName).localeCompare(a.deletedAt || a.dirName));
  return items;
}

/** 从回收站恢复书籍：目录改名回 books/ 并清空 deleted_at */
export function restoreBook(id: string): BookDTO | null {
  const row = getBookRow(id);
  if (!row || !row.deleted_at) return null;
  const trashDir = findTrashDir(id);
  if (trashDir) {
    const dest = bookDir(id);
    if (fs.existsSync(dest)) throw new Error('目标目录已存在，无法恢复');
    fs.renameSync(trashDir, dest);
  }
  tx(() => {
    db()
      .prepare(`UPDATE books SET deleted_at = NULL, updated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  });
  logger.info(`恢复书籍: ${row.title} (${id})`);
  return getBook(id);
}

/** 彻底删除：删数据库记录并物理删除目录（沙箱拦截时目录保留在 trash/_purged） */
export function purgeBook(id: string): { purged: boolean; dataKept: boolean } {
  const row = getBookRow(id);
  if (!row) return { purged: false, dataKept: false };
  const trashDir = findTrashDir(id);
  let dataKept = false;
  if (trashDir) {
    const purgedDir = path.join(trashRoot(), '_purged', path.basename(trashDir));
    removeBookDir(id);
    dataKept = fs.existsSync(trashDir) || fs.existsSync(purgedDir);
  } else {
    removeBookDir(id);
  }
  tx(() => {
    db().prepare(`DELETE FROM chapters WHERE book_id = ?`).run(id);
    db().prepare(`DELETE FROM assets WHERE book_id = ?`).run(id);
    db().prepare(`DELETE FROM books WHERE id = ?`).run(id);
  });
  logger.info(`彻底删除书籍: ${row.title} (${id})`);
  return { purged: true, dataKept };
}

function touchBook(bookId: string) {
  db().prepare(`UPDATE books SET updated_at = ? WHERE id = ?`).run(nowIso(), bookId);
}

/** 阅读用：返回改写过资源链接的正文 HTML */
export function renderChapter(bookId: string, chapterId: string): { title: string; html: string } | null {
  const ch = getChapterRow(bookId, chapterId);
  if (!ch) return null;
  let raw = '';
  try {
    raw = readContentText(bookId, ch.href);
  } catch {
    raw = '';
  }
  const body = extractBody(raw);
  const html = rewriteResourceUrls(body, ch.href, (target) => {
    if (!contentExists(bookId, target)) return null;
    return `/api/books/${bookId}/assets/${encodeHrefForUrl(target)}`;
  });
  return { title: ch.title, html };
}

/** 整理用：返回 body 内部的原始 HTML 源码 */
export function getChapterSource(bookId: string, chapterId: string): { title: string; html: string } | null {
  const ch = getChapterRow(bookId, chapterId);
  if (!ch) return null;
  let raw = '';
  try {
    raw = readContentText(bookId, ch.href);
  } catch {
    raw = '';
  }
  return { title: ch.title, html: extractBody(raw).trim() };
}

export function updateChapter(
  bookId: string,
  chapterId: string,
  patch: { title?: string; html?: string }
): ChapterDTO | null {
  const ch = getChapterRow(bookId, chapterId);
  if (!ch) return null;
  const ts = nowIso();

  if (patch.html !== undefined) {
    let original = '';
    try {
      original = readContentText(bookId, ch.href);
    } catch {
      original = '';
    }
    const next = original
      ? replaceBody(original, patch.html)
      : wrapDocument(patch.title ?? ch.title, patch.html);
    writeContent(bookId, ch.href, next);
  }

  db()
    .prepare(`UPDATE chapters SET title = ?, updated_at = ? WHERE id = ?`)
    .run(patch.title ?? ch.title, ts, chapterId);
  touchBook(bookId);
  return listChapters(bookId).find((c) => c.id === chapterId) ?? null;
}

export function createChapter(
  bookId: string,
  opts: { title?: string; html?: string; afterChapterId?: string | null }
): ChapterDTO | null {
  if (!getBookRow(bookId)) return null;
  const chapters = listChapters(bookId);
  let insertAt = chapters.length;
  if (opts.afterChapterId) {
    const i = chapters.findIndex((c) => c.id === opts.afterChapterId);
    if (i >= 0) insertAt = i + 1;
  }
  const id = uid();
  const ts = nowIso();
  const title = opts.title?.trim() || '新章节';
  const href = `epubmaker/text/${id}.xhtml`;
  writeContent(bookId, href, wrapDocument(title, opts.html ?? `<h2>${title}</h2>\n<p></p>`));

  tx(() => {
    const d = db();
    d.prepare(`UPDATE chapters SET idx = idx + 1 WHERE book_id = ? AND idx >= ?`).run(bookId, insertAt);
    d.prepare(
      `INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
    ).run(id, bookId, insertAt, title, href, ts, ts);
  });
  touchBook(bookId);
  return listChapters(bookId).find((c) => c.id === id) ?? null;
}

export function deleteChapter(bookId: string, chapterId: string): boolean {
  const ch = getChapterRow(bookId, chapterId);
  if (!ch) return false;
  tx(() => {
    db().prepare(`DELETE FROM chapters WHERE id = ?`).run(chapterId);
    const rest = db()
      .prepare(`SELECT id FROM chapters WHERE book_id = ? ORDER BY idx ASC`)
      .all<{ id: string }>(bookId);
    const st = db().prepare(`UPDATE chapters SET idx = ? WHERE id = ?`);
    rest.forEach((r, i) => st.run(i, r.id));
  });
  // 正文文件保留在磁盘上（可能被其它引用），仅从目录中移除
  touchBook(bookId);
  return true;
}

export function reorderChapters(bookId: string, orderedIds: string[]): ChapterDTO[] {
  const existing = listChapters(bookId);
  const known = new Set(existing.map((c) => c.id));
  const ordered = orderedIds.filter((id) => known.has(id));
  for (const c of existing) if (!ordered.includes(c.id)) ordered.push(c.id);
  tx(() => {
    const st = db().prepare(`UPDATE chapters SET idx = ? WHERE id = ? AND book_id = ?`);
    ordered.forEach((id, i) => st.run(i, id, bookId));
  });
  touchBook(bookId);
  return listChapters(bookId);
}

/** 合并若干章节到目标章节（按当前顺序追加正文） */
export function mergeChapters(bookId: string, targetId: string, sourceIds: string[]): ChapterDTO[] | null {
  const target = getChapterRow(bookId, targetId);
  if (!target) return null;
  const chapters = listChapters(bookId);
  const sources = chapters.filter((c) => sourceIds.includes(c.id) && c.id !== targetId);
  if (!sources.length) return chapters;

  let merged = getChapterSource(bookId, targetId)?.html ?? '';
  for (const s of sources) {
    const part = getChapterSource(bookId, s.id);
    if (part) merged += `\n<hr class="epubmaker-merge"/>\n${part.html}`;
  }
  updateChapter(bookId, targetId, { html: merged });
  for (const s of sources) deleteChapter(bookId, s.id);
  return listChapters(bookId);
}

/* ------------------------------------------------------------------ */
/* 拆分                                                                */
/* ------------------------------------------------------------------ */

export interface SplitPart {
  title: string;
  author?: string;
  chapterIds: string[];
  /** 该分卷的封面：字符串=指定图片 href；null=不使用封面；undefined=沿用原书封面 */
  coverHref?: string | null;
}

/** 计算某组章节需要携带的资源集合 */
function collectNeededAssets(bookId: string, chapterHrefs: string[], coverHref: string | null): Set<string> {
  const assets = new Map(listAssets(bookId).map((a) => [a.href, a]));
  const needed = new Set<string>();
  const queue: string[] = [];

  const add = (href: string) => {
    const h = normalizeHref(href);
    if (!assets.has(h) || needed.has(h)) return;
    needed.add(h);
    queue.push(h);
  };

  for (const href of chapterHrefs) {
    let html = '';
    try {
      html = readContentText(bookId, href);
    } catch {
      continue;
    }
    for (const r of collectReferences(html, href)) add(r);
  }
  // 样式表始终全量携带，避免排版丢失
  for (const [href, a] of assets) if (a.media_type === 'text/css') add(href);
  if (coverHref) add(coverHref);

  while (queue.length) {
    const href = queue.shift()!;
    if (!href.toLowerCase().endsWith('.css')) continue;
    try {
      for (const r of collectCssReferences(readContentText(bookId, href), href)) add(r);
    } catch {
      /* ignore */
    }
  }
  return needed;
}

export function splitBook(
  bookId: string,
  parts: SplitPart[],
  opts: { deleteSource?: boolean } = {}
): BookDTO[] {
  const book = getBookRow(bookId);
  if (!book) throw new Error('书籍不存在');
  const chapters = listChapters(bookId);
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const created: string[] = [];

  for (const part of parts) {
    const picked = part.chapterIds.map((id) => byId.get(id)).filter(Boolean) as ChapterDTO[];
    if (!picked.length) continue;

    const newId = uid();
    const ts = nowIso();
    // 该分卷的封面：显式指定（含 null 表示不用）则优先，否则沿用原书封面
    const effectiveCover = part.coverHref !== undefined ? part.coverHref : book.cover_href;
    const needed = collectNeededAssets(
      bookId,
      picked.map((c) => c.href),
      effectiveCover
    );

    // 拷贝正文
    for (const c of picked) {
      try {
        writeContent(newId, c.href, readContent(bookId, c.href));
      } catch {
        writeContent(newId, c.href, wrapDocument(c.title, ''));
      }
    }
    // 拷贝资源
    const assetRows = listAssets(bookId).filter((a) => needed.has(a.href));
    for (const a of assetRows) {
      try {
        writeContent(newId, a.href, readContent(bookId, a.href));
      } catch {
        /* 源文件缺失则跳过 */
      }
    }

    tx(() => {
      const d = db();
      d.prepare(
        `INSERT INTO books (id,title,author,language,publisher,description,identifier,cover_href,source_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        newId,
        part.title?.trim() || `${book.title} - 分卷`,
        (part.author ?? book.author) || '',
        book.language,
        book.publisher,
        book.description,
        '',
        effectiveCover && needed.has(effectiveCover) ? effectiveCover : null,
        book.source_name,
        ts,
        ts
      );
      const st = d.prepare(
        `INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
      );
      picked.forEach((c, i) => st.run(uid(), newId, i, c.title, c.href, ts, ts));
      const sa = d.prepare(`INSERT INTO assets (id,book_id,href,media_type,size) VALUES (?,?,?,?,?)`);
      for (const a of assetRows) sa.run(uid(), newId, a.href, a.media_type, contentSize(newId, a.href));
    });

    created.push(newId);
    logger.info(`拆分生成新书: ${part.title} (${newId})，章节 ${picked.length} 个`);
  }

  if (opts.deleteSource && created.length) deleteBook(bookId);
  return created.map((id) => getBook(id)!).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export async function exportBook(bookId: string): Promise<{ file: string; fileName: string }> {
  const book = getBookRow(bookId);
  if (!book) throw new Error('书籍不存在');
  const chapters = listChapters(bookId);
  if (!chapters.length) throw new Error('书籍没有任何章节，无法导出');

  const buildChapters: BuildChapter[] = chapters.map((c) => {
    let content: Buffer | string;
    try {
      content = readContent(bookId, c.href);
    } catch {
      content = wrapDocument(c.title, `<h2>${stripTags(c.title)}</h2>`);
    }
    return { title: c.title, href: c.href, content };
  });

  const buildAssets: BuildAsset[] = [];
  const seen = new Set<string>(chapters.map((c) => c.href));
  for (const a of listAssets(bookId)) {
    if (seen.has(a.href)) continue;
    if (!contentExists(bookId, a.href)) continue;
    seen.add(a.href);
    // 以可读流形式交给打包器，大图片不必整块载入内存
    buildAssets.push({
      href: a.href,
      mediaType: a.media_type,
      content: fs.createReadStream(contentPath(bookId, a.href))
    });
  }
  if (book.cover_href && !seen.has(book.cover_href) && contentExists(bookId, book.cover_href)) {
    buildAssets.push({
      href: book.cover_href,
      mediaType: guessMediaType(book.cover_href),
      content: fs.createReadStream(contentPath(bookId, book.cover_href))
    });
  }

  const fileName = `${sanitizeFileName(book.title)}.epub`;
  const outFile = path.join(config().paths.exports, `${sanitizeFileName(book.title)}-${bookId.slice(0, 8)}.epub`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // 流式生成并写入文件：内存中只保留正在处理的那个分片
  await new Promise<void>((resolve, reject) => {
    const stream = buildEpub({
      title: book.title,
      author: book.author,
      language: book.language || 'zh',
      publisher: book.publisher,
      description: book.description,
      identifier: book.identifier,
      coverHref: book.cover_href,
      chapters: buildChapters,
      assets: buildAssets
    });
    const out = fs.createWriteStream(outFile);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });

  const { size } = fs.statSync(outFile);
  logger.info(`导出 EPUB: ${outFile} (${(size / 1024).toFixed(1)} KB)`);
  return { file: outFile, fileName };
}

export function assetFilePath(bookId: string, href: string): string {
  return contentPath(bookId, href);
}

/* ------------------------------------------------------------------ */
/* 封面上传                                                            */
/* ------------------------------------------------------------------ */

export interface UploadedCover {
  href: string;
  url: string;
  mediaType: string;
}

/**
 * 向原书资源目录存入一张新封面图，并登记为图片资源。
 * 返回后该图会出现在 images 列表中，可在拆分 / 整理时被任意分卷选用。
 */
export async function uploadCover(
  bookId: string,
  file: { buffer: Buffer; name: string }
): Promise<UploadedCover> {
  if (!getBookRow(bookId)) throw new Error('书籍不存在');
  const ext = (path.extname(file.name) || '.png').toLowerCase().replace(/[^\w.]/g, '') || '.png';
  const mediaType = guessMediaType(`cover${ext}`);
  if (!mediaType.startsWith('image/')) throw new Error('封面仅支持图片文件');

  const href = `epubmaker/covers/${uid()}${ext}`;
  writeContent(bookId, href, file.buffer);
  const ts = nowIso();
  db()
    .prepare(`INSERT INTO assets (id,book_id,href,media_type,size) VALUES (?,?,?,?,?)`)
    .run(uid(), bookId, href, mediaType, file.buffer.length);

  logger.info(`上传封面: ${bookId} <- ${href}`);
  return { href, url: `/api/books/${bookId}/assets/${encodeHrefForUrl(href)}`, mediaType };
}

/** 把已存在于原书中的某张图片设为书籍封面（供整理页复用） */
export function setBookCover(bookId: string, href: string | null): BookDTO | null {
  const book = getBookRow(bookId);
  if (!book) return null;
  db().prepare(`UPDATE books SET cover_href = ?, updated_at = ? WHERE id = ?`).run(href, nowIso(), bookId);
  return getBook(bookId);
}
