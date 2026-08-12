import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config';
import { logger } from '../logger';
import { sanitizeFileName } from './storage';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface WebDavConnection {
  /** WebDAV 服务器根地址，例如 https://dav.example.com/dav */
  baseUrl: string;
  username?: string;
  password?: string;
  /** 忽略 TLS 证书错误（自签证书用） */
  insecure?: boolean;
}

export interface WebDavEntry {
  /** 显示名（已解码） */
  name: string;
  /** 相对 baseUrl 的路径；目录以 / 结尾 */
  path: string;
  isDirectory: boolean;
  size: number;
  /** 最后修改时间（ISO 字符串或 null） */
  lastModified: string | null;
}

export interface WebDavTestResult {
  connected: boolean;
  /** 服务器标识（Server / DAV 头） */
  server?: string;
  error?: string;
}

/** 连接参数非法 / 服务器返回错误时抛出 */
export class WebDavError extends Error {}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:displayname/>
  </D:prop>
</D:propfind>`;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text'
});

/* ------------------------------------------------------------------ */
/* 连接参数校验                                                        */
/* ------------------------------------------------------------------ */

export function normalizeConn(input: unknown): WebDavConnection {
  const obj = (input ?? {}) as Record<string, unknown>;
  const baseUrl = String(obj.baseUrl ?? '').trim();
  if (!baseUrl) throw new WebDavError('请填写 WebDAV 服务器地址');
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new WebDavError('服务器地址格式不正确（需为完整 http(s) URL）');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new WebDavError('仅支持 http / https 协议的 WebDAV 地址');
  }
  return {
    baseUrl: u.toString(),
    username: obj.username ? String(obj.username) : undefined,
    password: obj.password ? String(obj.password) : undefined,
    insecure: !!obj.insecure
  };
}

/* ------------------------------------------------------------------ */
/* URL / 路径工具                                                      */
/* ------------------------------------------------------------------ */

/** 把相对路径拼到 baseUrl 之后，目录结尾自动补 / */
function resolveUrl(baseUrl: string, relPath: string): string {
  const u = new URL(baseUrl);
  const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
  const rel = relPath.startsWith('/') ? relPath.slice(1) : relPath;
  u.pathname = basePath + rel;
  return u.toString();
}

/** 把服务器返回的 href（可能是绝对 URL 或相对路径）折算成相对 baseUrl 的路径 */
function relativize(href: string, baseUrl: string): string {
  let abs = href;
  try {
    abs = new URL(href, baseUrl).toString();
  } catch {
    /* 保持原样 */
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  let rel = abs;
  if (abs.startsWith(base.origin)) rel = abs.slice(base.origin.length);
  if (rel.startsWith(basePath)) rel = rel.slice(basePath.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  return rel;
}

function basenameOf(rel: string): string {
  const trimmed = rel.endsWith('/') ? rel.slice(0, -1) : rel;
  const i = trimmed.lastIndexOf('/');
  const name = i >= 0 ? trimmed.slice(i + 1) : trimmed;
  return name ? decodeURIComponent(name) : trimmed;
}

/* ------------------------------------------------------------------ */
/* TLS（自签证书）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 在回调执行期间临时关闭 TLS 证书校验（仅在用户勾选“忽略证书错误”时启用）。
 * 这是 Node fetch 在不引入额外依赖前提下的可行方案；仅作用于本进程全局，
 * 调用方应保证 insecure 仅由用户显式开启，且请求顺序执行（本应用为单用户本地工具）。
 */
async function withInsecure<T>(conn: WebDavConnection, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (conn.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fn();
  } finally {
    if (conn.insecure) {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 头                                                             */
/* ------------------------------------------------------------------ */

function authHeader(conn: WebDavConnection): Record<string, string> {
  if (conn.username) {
    const token = Buffer.from(`${conn.username}:${conn.password ?? ''}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* PROPFIND 解析                                                       */
/* ------------------------------------------------------------------ */

function pickProp(response: any): any {
  const ps = response?.propstat;
  if (!ps) return undefined;
  const arr = Array.isArray(ps) ? ps : [ps];
  const good = arr.find((x: any) => /200/.test(String(x?.status ?? '')));
  const chosen = good ?? arr[0];
  return chosen?.prop;
}

function hrefOf(response: any): string {
  const h = response?.href;
  if (typeof h === 'string') return h;
  if (h && typeof h === 'object' && '#text' in h) return String(h['#text']);
  return '';
}

function parsePropfind(xml: string, baseUrl: string, requestedPath: string): WebDavEntry[] {
  const parsed = xmlParser.parse(xml);
  const raw = parsed?.multistatus?.response;
  if (!raw) return [];
  const responses = Array.isArray(raw) ? raw : [raw];

  const out: WebDavEntry[] = [];
  for (const r of responses) {
    const href = hrefOf(r);
    if (!href) continue;
    const rel = relativize(href, baseUrl);
    // 跳过“目录自身”这一条（PROPFIND Depth:1 会把请求目录也返回一次）
    if (rel === requestedPath) continue;

    const prop = pickProp(r);
    const resType = prop?.resourcetype;
    const isDir =
      !!resType && typeof resType === 'object' && Object.prototype.hasOwnProperty.call(resType, 'collection');

    let p = rel;
    if (isDir && !p.endsWith('/')) p += '/';

    const size = prop?.getcontentlength ? Number(prop.getcontentlength) || 0 : 0;
    let lastModified: string | null = null;
    if (prop?.getlastmodified) {
      const t = Date.parse(String(prop.getlastmodified));
      lastModified = Number.isNaN(t) ? String(prop.getlastmodified) : new Date(t).toISOString();
    }
    const name = prop?.displayname ? String(prop.displayname) : basenameOf(p);

    out.push({ name, path: p, isDirectory: isDir, size, lastModified });
  }

  // 目录在前、文件在后，各自按名称排序
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export async function testWebDav(conn: WebDavConnection): Promise<WebDavTestResult> {
  return withInsecure(conn, async () => {
    const url = resolveUrl(conn.baseUrl, '');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PROPFIND',
        headers: { ...authHeader(conn), Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY
      });
    } catch (err) {
      throw new WebDavError(`无法连接服务器：${(err as Error).message}`);
    }
    if (res.status === 401) throw new WebDavError('认证失败：用户名或密码错误');
    if (res.status === 403) throw new WebDavError('服务器拒绝访问（403 Forbidden）');
    if (!res.ok) throw new WebDavError(`服务器返回错误 (${res.status} ${res.statusText})`);

    // 207 Multi-Status 表示确实是 WebDAV；其它 2xx 也视为可连通
    const dav = res.headers.get('dav');
    const server = res.headers.get('server') ?? undefined;
    if (res.status !== 207 && !dav) {
      logger.warn(`WebDAV 探测：服务器未返回 207/DAV 头，仍按可连接处理（${conn.baseUrl}）`);
    }
    return { connected: true, server };
  });
}

export async function listWebDav(conn: WebDavConnection, dirPath: string): Promise<WebDavEntry[]> {
  return withInsecure(conn, async () => {
    const url = resolveUrl(conn.baseUrl, dirPath || '');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PROPFIND',
        headers: { ...authHeader(conn), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY
      });
    } catch (err) {
      throw new WebDavError(`无法列出目录：${(err as Error).message}`);
    }
    if (res.status === 401) throw new WebDavError('认证失败：用户名或密码错误');
    if (!res.ok) throw new WebDavError(`列出目录失败 (${res.status} ${res.statusText})`);

    const xml = await res.text();
    return parsePropfind(xml, conn.baseUrl, dirPath || '');
  });
}

/** 把远程文件流式下载到本地临时路径（调用方负责清理与导入） */
export async function downloadWebDavFile(
  conn: WebDavConnection,
  filePath: string,
  destPath: string
): Promise<void> {
  await withInsecure(conn, async () => {
    const url = resolveUrl(conn.baseUrl, filePath);
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: { ...authHeader(conn) } });
    } catch (err) {
      throw new WebDavError(`下载失败：${(err as Error).message}`);
    }
    if (res.status === 401) throw new WebDavError('认证失败：用户名或密码错误');
    if (!res.ok || !res.body) throw new WebDavError(`下载失败 (${res.status} ${res.statusText})`);

    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(destPath));
  });
}

/** 生成下载用的临时文件路径（落盘到 tmp 目录，避免整本 epub 驻留内存） */
export function webdavTempPath(name: string): string {
  const base = sanitizeFileName(name) || 'book.epub';
  return path.join(
    config().paths.tmp,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`
  );
}
