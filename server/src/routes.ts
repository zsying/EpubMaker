import express, { Request, Response, Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { logger } from './logger';
import { guessMediaType } from './epub/mime';
import * as lib from './services/library';

const upload = multer({
  // 落地到 tmp 目录，避免整本（可能数百 MB）epub 驻留内存
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config().paths.tmp),
    filename: (req, file, cb) => {
      const base = path.basename(file.originalname).replace(/[^\w.\-一-龥]/g, '_');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`);
    }
  }),
  limits: { fileSize: config().maxUploadSizeMb * 1024 * 1024 }
});

function ok(res: Response, data: unknown) {
  res.json({ ok: true, data });
}
function fail(res: Response, status: number, message: string) {
  res.status(status).json({ ok: false, error: message });
}

/** 包装异步 handler，统一捕获异常 */
function wrap(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      logger.error(`[${req.method} ${req.originalUrl}]`, err as Error);
      if (!res.headersSent) fail(res, 500, (err as Error).message || '服务器内部错误');
    }
  };
}

export function createRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '20mb' }));

  r.get('/health', (_req, res) => ok(res, { status: 'ok', time: new Date().toISOString() }));

  r.get('/config', (_req, res) => {
    const c = config();
    ok(res, {
      appHome: c.appHome,
      configFile: c.configFile,
      dataDir: c.paths.data,
      exportDir: c.paths.exports,
      logDir: c.paths.logs,
      dbFile: c.paths.dbFile
    });
  });

  /* ---------------- 书籍 ---------------- */

  r.get(
    '/books',
    wrap((req, res) => {
      const keyword = (req.query.keyword as string | undefined)?.trim();
      ok(res, lib.listBooks(keyword || undefined));
    })
  );

  r.post(
    '/books/import',
    upload.array('files', 20),
    wrap(async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) return fail(res, 400, '未收到文件');
      const created = [];
      const errors: string[] = [];
      for (const f of files) {
        const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
        try {
          created.push(await lib.importEpub(f.path, name));
        } catch (err) {
          logger.error(`导入失败 ${name}:`, err as Error);
          errors.push(`${name}: ${(err as Error).message}`);
        } finally {
          // 无论成功失败都清理临时上传文件
          fs.promises.unlink(f.path).catch(() => {});
        }
      }
      if (!created.length) return fail(res, 400, errors.join('\n') || '导入失败');
      ok(res, { books: created, errors });
    })
  );

  r.get(
    '/books/:id',
    wrap((req, res) => {
      const book = lib.getBook(req.params.id);
      if (!book) return fail(res, 404, '书籍不存在');
      ok(res, book);
    })
  );

  r.patch(
    '/books/:id',
    wrap((req, res) => {
      const book = lib.updateBook(req.params.id, req.body ?? {});
      if (!book) return fail(res, 404, '书籍不存在');
      ok(res, book);
    })
  );

  r.delete(
    '/books/:id',
    wrap((req, res) => {
      const out = lib.deleteBook(req.params.id);
      if (!out.deleted) return fail(res, 404, '书籍不存在');
      ok(res, out);
    })
  );

  /* ---------------- 回收站 ---------------- */

  r.get(
    '/trash',
    wrap((req, res) => {
      ok(res, lib.listTrash());
    })
  );

  r.post(
    '/trash/:id/restore',
    wrap((req, res) => {
      const book = lib.restoreBook(req.params.id);
      if (!book) return fail(res, 404, '回收站中不存在该书');
      ok(res, book);
    })
  );

  r.delete(
    '/trash/:id',
    wrap((req, res) => {
      const out = lib.purgeBook(req.params.id);
      if (!out.purged) return fail(res, 404, '回收站中不存在该书');
      ok(res, out);
    })
  );

  /* ---------------- 章节 ---------------- */

  r.get(
    '/books/:id/chapters',
    wrap((req, res) => ok(res, lib.listChapters(req.params.id)))
  );

  r.post(
    '/books/:id/chapters/reorder',
    wrap((req, res) => {
      const ids = (req.body?.chapterIds ?? []) as string[];
      ok(res, lib.reorderChapters(req.params.id, ids));
    })
  );

  r.post(
    '/books/:id/chapters/merge',
    wrap((req, res) => {
      const { targetId, sourceIds } = req.body ?? {};
      const out = lib.mergeChapters(req.params.id, targetId, sourceIds ?? []);
      if (!out) return fail(res, 404, '目标章节不存在');
      ok(res, out);
    })
  );

  r.post(
    '/books/:id/chapters',
    wrap((req, res) => {
      const ch = lib.createChapter(req.params.id, req.body ?? {});
      if (!ch) return fail(res, 404, '书籍不存在');
      ok(res, ch);
    })
  );

  r.get(
    '/books/:id/chapters/:cid/render',
    wrap((req, res) => {
      const out = lib.renderChapter(req.params.id, req.params.cid);
      if (!out) return fail(res, 404, '章节不存在');
      ok(res, out);
    })
  );

  r.get(
    '/books/:id/chapters/:cid/source',
    wrap((req, res) => {
      const out = lib.getChapterSource(req.params.id, req.params.cid);
      if (!out) return fail(res, 404, '章节不存在');
      ok(res, out);
    })
  );

  r.patch(
    '/books/:id/chapters/:cid',
    wrap((req, res) => {
      const out = lib.updateChapter(req.params.id, req.params.cid, req.body ?? {});
      if (!out) return fail(res, 404, '章节不存在');
      ok(res, out);
    })
  );

  r.delete(
    '/books/:id/chapters/:cid',
    wrap((req, res) => {
      if (!lib.deleteChapter(req.params.id, req.params.cid)) return fail(res, 404, '章节不存在');
      ok(res, { deleted: true });
    })
  );

  /* ---------------- 资源 ---------------- */

  r.get(
    '/books/:id/images',
    wrap((req, res) => {
      const images = lib
        .listAssets(req.params.id)
        .filter((a) => a.media_type.startsWith('image/'))
        .map((a) => ({
          href: a.href,
          size: a.size,
          url: `/api/books/${req.params.id}/assets/${a.href.split('/').map(encodeURIComponent).join('/')}`
        }));
      ok(res, images);
    })
  );

  r.get(
    '/books/:id/assets/*',
    wrap((req, res) => {
      const href = decodeURIComponent((req.params as unknown as Record<string, string>)[0] ?? '');
      let file: string;
      try {
        file = lib.assetFilePath(req.params.id, href);
      } catch {
        return fail(res, 400, '非法路径');
      }
      if (!fs.existsSync(file)) return fail(res, 404, '资源不存在');
      res.setHeader('Content-Type', guessMediaType(href));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(file).pipe(res);
    })
  );

  /* ---------------- 封面上传 ---------------- */

  r.post(
    '/books/:id/covers',
    upload.single('cover'),
    wrap(async (req, res) => {
      const f = req.file;
      if (!f) return fail(res, 400, '未收到封面文件');
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        const buf = await fs.promises.readFile(f.path);
        const out = await lib.uploadCover(req.params.id, { buffer: buf, name });
        ok(res, out);
      } catch (err) {
        logger.error(`封面上传失败:`, err as Error);
        return fail(res, 400, (err as Error).message);
      } finally {
        fs.promises.unlink(f.path).catch(() => {});
      }
    })
  );

  /* ---------------- 拆分 / 导出 ---------------- */

  r.post(
    '/books/:id/split',
    wrap((req, res) => {
      const parts = (req.body?.parts ?? []) as lib.SplitPart[];
      if (!Array.isArray(parts) || !parts.length) return fail(res, 400, '请至少提供一个分卷');
      const books = lib.splitBook(req.params.id, parts, { deleteSource: !!req.body?.deleteSource });
      ok(res, books);
    })
  );

  r.get(
    '/books/:id/export',
    wrap(async (req, res) => {
      const { file, fileName } = await lib.exportBook(req.params.id);
      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
      fs.createReadStream(file).pipe(res);
    })
  );

  return r;
}
