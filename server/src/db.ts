import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { logger } from './logger';

/**
 * 极薄的 SQLite 适配层。
 * 优先使用 better-sqlite3（性能更好），若原生模块不可用则回退到 Node 内置 node:sqlite。
 * 只使用位置参数 `?`，两种驱动行为一致。
 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  driver: string;
}

function openBetterSqlite(file: string): SqliteDb | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return {
      driver: 'better-sqlite3',
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        return {
          run: (...p: unknown[]) => st.run(...p),
          get: <T,>(...p: unknown[]) => st.get(...p) as T | undefined,
          all: <T,>(...p: unknown[]) => st.all(...p) as T[]
        };
      }
    };
  } catch (err) {
    logger.debug('better-sqlite3 不可用：' + (err as Error).message);
    return null;
  }
}

function openNodeSqlite(file: string): SqliteDb | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    return {
      driver: 'node:sqlite',
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        return {
          run: (...p: unknown[]) => st.run(...(p as never[])) as { changes: number },
          get: <T,>(...p: unknown[]) => st.get(...(p as never[])) as T | undefined,
          all: <T,>(...p: unknown[]) => st.all(...(p as never[])) as T[]
        };
      }
    };
  } catch (err) {
    logger.debug('node:sqlite 不可用：' + (err as Error).message);
    return null;
  }
}

let dbInstance: SqliteDb | null = null;

export function db(): SqliteDb {
  if (dbInstance) return dbInstance;
  const file = config().paths.dbFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const instance = openBetterSqlite(file) ?? openNodeSqlite(file);
  if (!instance) {
    throw new Error(
      ' 无法打开 SQLite：请安装 better-sqlite3（npm i better-sqlite3 -w server），或使用 Node >= 22.5 并开启 --experimental-sqlite。'
    );
  }
  logger.info(`SQLite 已连接 (${instance.driver}): ${file}`);
  dbInstance = instance;
  migrate(instance);
  return instance;
}

function migrate(d: SqliteDb) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'zh',
      publisher TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      identifier TEXT NOT NULL DEFAULT '',
      cover_href TEXT,
      source_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      href TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      href TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_assets_book ON assets(book_id);
  `);
  // 迁移：旧库补 deleted_at 列（软删除 / 回收站用）
  try {
    d.exec(`ALTER TABLE books ADD COLUMN deleted_at TEXT`);
  } catch {
    /* 列已存在则忽略 */
  }
}

/** 手动事务，兼容两种驱动 */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
export const uid = () => (globalThis.crypto?.randomUUID?.() ?? require('node:crypto').randomUUID());
