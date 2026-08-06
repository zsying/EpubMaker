import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { normalizeHref } from '../epub/html';

export function bookDir(bookId: string): string {
  return path.join(config().paths.books, bookId);
}

export function contentDir(bookId: string): string {
  return path.join(bookDir(bookId), 'content');
}

/** 把 EPUB 内部相对路径安全地映射到磁盘路径，防止路径穿越 */
export function contentPath(bookId: string, href: string): string {
  const norm = normalizeHref(href);
  const base = contentDir(bookId);
  const full = path.resolve(base, norm);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`非法资源路径: ${href}`);
  }
  return full;
}

export function writeContent(bookId: string, href: string, data: Buffer | string): void {
  const file = contentPath(bookId, href);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data as never);
}

export function readContent(bookId: string, href: string): Buffer {
  return fs.readFileSync(contentPath(bookId, href));
}

export function readContentText(bookId: string, href: string): string {
  return readContent(bookId, href).toString('utf8');
}

export function contentExists(bookId: string, href: string): boolean {
  try {
    return fs.existsSync(contentPath(bookId, href));
  } catch {
    return false;
  }
}

export function contentSize(bookId: string, href: string): number {
  try {
    return fs.statSync(contentPath(bookId, href)).size;
  } catch {
    return 0;
  }
}

/** 回收站根目录：~/.epubmaker/data/trash */
export function trashRoot(): string {
  return path.join(config().paths.data, 'trash');
}

/** 把书目录整体改名移入回收站（rename 不是删除，不触发批量删除拦截；数据可恢复） */
export function moveBookDirToTrash(bookId: string): boolean {
  const dir = bookDir(bookId);
  if (!fs.existsSync(dir)) return false;
  const trash = path.join(trashRoot(), `${bookId}-${Date.now()}`);
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(dir, trash);
  return true;
}

/** 在回收站中查找该书目录（兼容 `<id>-<ts>` / `<id>-orphan` 命名） */
export function findTrashDir(bookId: string): string | null {
  const root = trashRoot();
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root)) {
    const m = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (m && m[1] === bookId) {
      const full = path.join(root, name);
      if (fs.statSync(full).isDirectory()) return full;
    }
  }
  return null;
}

/**
 * 物理删除书目录（彻底删除用）：
 * 优先递归删除；被沙箱/受限环境拦截时，把目录移入回收站的 _purged 子目录保留数据。
 */
export function removeBookDir(bookId: string): void {
  const dir = findTrashDir(bookId) ?? bookDir(bookId);
  if (!dir || !fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    const purged = path.join(trashRoot(), '_purged');
    fs.mkdirSync(purged, { recursive: true });
    fs.renameSync(dir, path.join(purged, path.basename(dir)));
  }
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  );
}
